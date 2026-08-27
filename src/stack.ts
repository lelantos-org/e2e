// Container lifecycle for the whole stack: network, postgres, anvil, the forge
// deploy, and the backend services that depend on its addresses.

import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
    Network,
    type StartedNetwork,
    type StartedTestContainer,
} from "testcontainers";

import { DEPLOYER, PAYER, RECIPIENT } from "./accounts.js";
import { type Addresses, requireToken, type StackEnv, type SwapAddresses, type Urls } from "./infra/addresses.js";
import { CHAIN_ID, CONTRACTS_DIR, E2E_DIR, logDir } from "./infra/docker.js";
import { FEE_BPS } from "./protocol/amounts.js";
import { FEE_TOKENS } from "./protocol/assets.js";
import type { FeeTokenSpec } from "./infra/relayer-config.js";
import { log } from "./utils.js";
import { CANONICAL_PERMIT2_ADDRESS, preDeployPermit2 } from "./permit2.js";
import { ANVIL, backendSpecs, ORACLE, POSTGRES, runService, type ServiceSpec } from "./services.js";

/** A started container plus the service alias its logs should be filed under. */
interface RunningService {
    alias: string;
    container: StartedTestContainer;
}

const execFileAsync = promisify(execFile);

export type { Addresses, StackEnv, SwapAddresses, Urls } from "./infra/addresses.js";

export class Stack {
    private network?: StartedNetwork;
    private postgres?: StartedTestContainer;
    private anvil?: StartedTestContainer;
    private backends: RunningService[] = [];
    private addresses?: Addresses;

    async up(): Promise<{ rpc: string }> {
        await ensureCircuits();
        this.network = await new Network().start();

        this.postgres = await runService(POSTGRES, this.network);
        this.anvil = await runService(ANVIL, this.network);

        // `DeployPermit2` in DeployTest.s.sol uses `vm.etch`, which is dropped
        // under `--broadcast`. Without this pre-deploy the MASP constructor
        // reverts with `ZeroPermit2()`.
        await preDeployPermit2(this.rpcUrl());

        return { rpc: this.rpcUrl() };
    }

    async deploy(): Promise<Addresses> {
        const rpcUrl = this.rpcUrl();
        const baseEnv: Record<string, string> = {
            ...process.env as Record<string, string>,
            MASP_FEE_BPS: FEE_BPS.toString(),
            // Permit2 is pre-deployed by `up()`; skip DeployTest's `vm.getCode`
            // fallback.
            PERMIT2: CANONICAL_PERMIT2_ADDRESS,
        };

        const coreOut = await runForgeScript("DeployTest", rpcUrl, baseEnv);
        this.addresses = parseDeployOutput(coreOut);

        // DeployTestSwap runs after the core deploy and reads
        // MASP/PERMIT2/TOKEN_* from env. E2E_SKIP_SWAP=1 skips it, so non-swap
        // suites can run without the mock UniV3 stack.
        if (process.env.E2E_SKIP_SWAP !== "1") {
            const swapEnv: Record<string, string> = {
                ...baseEnv,
                MASP: this.addresses.masp,
                PERMIT2: this.addresses.permit2,
            };
            for (const [id, addr] of Object.entries(this.addresses.tokens)) {
                swapEnv[`TOKEN_${id}`] = addr;
            }
            const swapOut = await runForgeScript("DeployTestSwap", rpcUrl, swapEnv);
            const swap = requireSwapAddresses(stripAnsi(swapOut), "swap deploy");
            this.addresses = { ...this.addresses, swap };
        }
        return this.addresses;
    }

    // The ingester runs alone first because it owns schema migrations; the
    // rest start in parallel.
    async upBackend(addrs: Addresses): Promise<Urls> {
        const network = this.network;
        if (!network) throw new Error("upBackend: call up() first");
        // Every registered asset is payable, so a test can pay the fee in the
        // asset it is already moving: a spend covers one asset and cannot pay
        // in another. `id` is the join to the deploy and is not part of the
        // relayer's config, so it is destructured away.
        const feeTokens: FeeTokenSpec[] = FEE_TOKENS.map(({ id, ...token }) => ({
            ...token,
            address: requireToken(addrs.tokens, id),
        }));
        const specs = backendSpecs({
            masp: addrs.masp,
            feeTokens,
            swap: addrs.swap,
            nativeAdapter: addrs.nativeAdapter,
        });

        const start = async (spec: ServiceSpec): Promise<StartedTestContainer> => {
            const container = await runService(spec, network);
            this.backends.push({ alias: spec.alias, container });
            return container;
        };

        // Before the relayer, which resolves every fee token's oracle pair at
        // boot and refuses to start if one is unreachable.
        await start(ORACLE);

        await start(specs.ingester);

        const rest = [
            specs.fmdIndexer,
            specs.explorerIndexer,
            specs.fmdWeb,
            specs.explorerWeb,
            specs.relayer,
            ...(specs.metaquoter ? [specs.metaquoter] : []),
        ];
        const [, , fmdWeb, explorerWeb, relayer, metaquoter] = await Promise.all(rest.map(start));

        return {
            rpc: this.rpcUrl(),
            fmd: hostUrl(fmdWeb, specs.fmdWeb.port!),
            explorer: hostUrl(explorerWeb, specs.explorerWeb.port!),
            relayer: hostUrl(relayer, specs.relayer.port!),
            metaquoter: metaquoter ? hostUrl(metaquoter, specs.metaquoter!.port!) : undefined,
        };
    }

    env(urls: Urls): StackEnv {
        if (!this.addresses) throw new Error("Stack.env: deploy() not run");
        return {
            ...urls,
            chainId: CHAIN_ID,
            masp: this.addresses.masp,
            tokens: this.addresses.tokens,
            payerAddress: PAYER.address,
            payerKey: PAYER.privateKey,
            recipientAddress: RECIPIENT.address,
            permit2: this.addresses.permit2,
            nativeAdapter: this.addresses.nativeAdapter,
            swap: this.addresses.swap,
        };
    }

    async down(): Promise<void> {
        dumpBackendLogs(this.backends);

        await Promise.all(
            this.allContainers().map((c) =>
                c.stop().catch((e) => log(`stopping ${c.getName()} failed: ${errText(e)}`)),
            ),
        );
        if (this.network) {
            await this.network.stop().catch((e) => log(`stopping network failed: ${errText(e)}`));
        }

        this.backends = [];
        this.postgres = undefined;
        this.anvil = undefined;
        this.network = undefined;
        this.addresses = undefined;
    }

    private rpcUrl(): string {
        if (!this.anvil) throw new Error("Stack.rpcUrl: call up() first");
        return `http://localhost:${this.anvil.getMappedPort(ANVIL.port!)}`;
    }

    /** Every container this stack owns, backends first so their logs dump first. */
    private allContainers(): StartedTestContainer[] {
        return [...this.backends.map((b) => b.container), this.postgres, this.anvil].filter(
            (c): c is StartedTestContainer => c !== undefined,
        );
    }
}

function hostUrl(c: StartedTestContainer, internalPort: number): string {
    return `http://localhost:${c.getMappedPort(internalPort)}`;
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Final `docker logs` dump, written alongside the per-service streams that
 * `runService` opens, under the same `logDir()` so CI collects both.
 *
 * Best-effort: teardown must finish even when a container is already gone, so
 * failures are reported and swallowed rather than thrown.
 */
function dumpBackendLogs(backends: readonly RunningService[]): void {
    const dir = logDir();
    try {
        mkdirSync(dir, { recursive: true });
    } catch (e) {
        log(`could not create ${dir}: ${errText(e)}`);
        return;
    }

    for (const { alias, container } of backends) {
        try {
            // spawnSync, not execFileSync: a non-zero exit is normal here (the
            // container may already be gone) and must not discard the output
            // already captured. Both streams are kept, since services log to
            // stderr.
            const r = spawnSync("docker", ["logs", container.getId()], {
                maxBuffer: 64 * 1024 * 1024,
            });
            if (r.error) throw r.error;
            const out = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]);
            writeFileSync(resolve(dir, `${alias}.docker.log`), out);
        } catch (e) {
            log(`could not dump logs for ${alias}: ${errText(e)}`);
        }
    }
}

/** Run a forge deploy script from the contracts dir and return its stdout. */
async function runForgeScript(
    name: string,
    rpcUrl: string,
    env: Record<string, string>,
): Promise<string> {
    const { stdout } = await execFileAsync(
        "forge",
        [
            "script", `script/${name}.s.sol:${name}`,
            "--rpc-url", rpcUrl,
            "--private-key", DEPLOYER.privateKey,
            "--broadcast",
            "--disable-code-size-limit",
        ],
        {
            cwd: CONTRACTS_DIR,
            maxBuffer: 64 * 1024 * 1024,
            env,
        },
    );
    return stdout;
}

// forge colourises its output; the address patterns below run on plain text.
function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** `KEY=0xaddress` pairs from forge script output. */
function parseAddressPairs(stripped: string): Map<string, string> {
    const re = /\b([A-Z][A-Z0-9_]*)=(0x[0-9a-fA-F]{40})/g;
    const found = new Map<string, string>();
    for (const m of stripped.matchAll(re)) found.set(m[1], m[2]);
    return found;
}

const SWAP_KEYS = [
    "UNIV3_QUOTER",
    "UNIV3_ADAPTER",
    "MOCK_SWAP_ROUTER",
    "UNIV4_QUOTER",
    "UNIV4_ADAPTER",
    "MOCK_UNIVERSAL_ROUTER",
    "SWAP_WRAPPER",
] as const;

function readSwapAddresses(found: Map<string, string>): SwapAddresses {
    return {
        univ3Quoter: found.get("UNIV3_QUOTER")!,
        univ3Adapter: found.get("UNIV3_ADAPTER")!,
        mockSwapRouter: found.get("MOCK_SWAP_ROUTER")!,
        univ4Quoter: found.get("UNIV4_QUOTER")!,
        univ4Adapter: found.get("UNIV4_ADAPTER")!,
        mockUniversalRouter: found.get("MOCK_UNIVERSAL_ROUTER")!,
        wrapper: found.get("SWAP_WRAPPER")!,
    };
}

/** Every swap address, or throw naming the first missing one. */
function requireSwapAddresses(stripped: string, what: string): SwapAddresses {
    const found = parseAddressPairs(stripped);
    for (const k of SWAP_KEYS) {
        if (!found.has(k)) throw new Error(`${what}: missing ${k} in forge output:\n${stripped}`);
    }
    return readSwapAddresses(found);
}

// The relayer mounts <e2e>/circuits/ at /circuits and reads
// tree_update_batch.{wasm,r1cs,_final.zkey} at startup. The fetch script is
// idempotent and skips when .version matches.
async function ensureCircuits(): Promise<void> {
    log("fetching circuits…");
    await execFileAsync("scripts/fetch-circuits.sh", [], { cwd: E2E_DIR });
}

function parseDeployOutput(stdout: string): Addresses {
    const stripped = stripAnsi(stdout);
    const found = parseAddressPairs(stripped);

    for (const k of ["SPEND_VERIFIER", "TREE_UPDATE_BATCH_VERIFIER", "MASP", "PERMIT2"]) {
        if (!found.has(k)) {
            throw new Error(`deploy: missing ${k} in forge output:\n${stripped}`);
        }
    }

    const tokens: Record<number, string> = {};
    for (const [k, v] of found) {
        const m = k.match(/^TOKEN_(\d+)$/);
        if (m) tokens[Number(m[1])] = v;
    }

    // The core script emits swap addresses only when it deployed them: all
    // four or none. A partial set means the script changed shape, and the
    // caller would otherwise get an object with `undefined` fields typed as
    // `string`.
    const swapPresent = SWAP_KEYS.filter((k) => found.has(k));
    if (swapPresent.length !== 0 && swapPresent.length !== SWAP_KEYS.length) {
        throw new Error(`deploy: partial swap addresses in forge output:\n${stripped}`);
    }

    return {
        verifier: found.get("SPEND_VERIFIER")!,
        treeUpdateVerifier: found.get("TREE_UPDATE_BATCH_VERIFIER")!,
        masp: found.get("MASP")!,
        tokens,
        wrappedNative: found.get("WRAPPED_NATIVE"),
        nativeAdapter: found.get("NATIVE_ADAPTER"),
        permit2: found.get("PERMIT2")!,
        swap: swapPresent.length === SWAP_KEYS.length ? readSwapAddresses(found) : undefined,
    };
}
