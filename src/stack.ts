import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
    Network,
    type StartedNetwork,
    type StartedTestContainer,
} from "testcontainers";

import { DEPLOYER, PAYER, RECIPIENT } from "./accounts.js";
import { CHAIN_ID, CONTRACTS_DIR, E2E_DIR, FEE_BPS } from "./constants.js";
import { log } from "./utils.js";
import { CANONICAL_PERMIT2_ADDRESS, preDeployPermit2 } from "./permit2.js";
import { ANVIL, backendSpecs, POSTGRES, runService } from "./services.js";

const execFileAsync = promisify(execFile);

export interface Addresses {
    verifier: string;
    treeUpdateVerifier: string;
    masp: string;
    tokens: Record<number, string>;
    wrappedNative?: string;
    nativeAdapter?: string;
    permit2: string;
    swap?: SwapAddresses;
}

export interface SwapAddresses {
    univ3Quoter: string;
    univ3Adapter: string;
    mockSwapRouter: string;
    wrapper: string;
}

export interface Urls {
    rpc: string;
    relayer: string;
    fmd: string;
    explorer: string;
    metaquoter?: string;
}

export interface StackEnv extends Urls {
    chainId: string;
    masp: string;
    tokens: Record<number, string>;
    payerAddress: string;
    payerKey: string;
    recipientAddress: string;
    permit2: string;
    nativeAdapter?: string;
    swap?: SwapAddresses;
}

export class Stack {
    private network?: StartedNetwork;
    private infra: StartedTestContainer[] = []; // [postgres, anvil]
    private backends: StartedTestContainer[] = [];
    private addresses?: Addresses;

    async up(): Promise<{ rpc: string }> {
        await ensureCircuits();
        this.network = await new Network().start();

        const postgres = await runService(POSTGRES, this.network);
        const anvil = await runService(ANVIL, this.network);
        this.infra = [postgres, anvil];

        // DeployPermit2 in DeployTest.s.sol uses vm.etch which is dropped under
        // --broadcast; MASP ctor reverts ZeroPermit2() without this pre-deploy.
        await preDeployPermit2(this.rpcUrl());

        return { rpc: this.rpcUrl() };
    }

    async deploy(): Promise<Addresses> {
        const rpcUrl = this.rpcUrl();
        const baseEnv: Record<string, string> = {
            ...process.env as Record<string, string>,
            MASP_FEE_BPS: FEE_BPS.toString(),
            // up() already pre-deployed Permit2; skip DeployTest's vm.getCode fallback.
            PERMIT2: CANONICAL_PERMIT2_ADDRESS,
        };

        const { stdout: coreOut } = await execFileAsync(
            "forge",
            [
                "script", "script/DeployTest.s.sol:DeployTest",
                "--rpc-url", rpcUrl,
                "--private-key", DEPLOYER.privateKey,
                "--broadcast",
                "--disable-code-size-limit",
            ],
            {
                cwd: CONTRACTS_DIR,
                maxBuffer: 64 * 1024 * 1024,
                env: baseEnv,
            },
        );
        this.addresses = parseDeployOutput(coreOut);

        // Run DeployTestSwap after core; reads MASP/PERMIT2/TOKEN_* from env.
        // Skip when E2E_SKIP_SWAP=1 (lets non-swap suites run without the
        // mock UniV3 stack).
        if (process.env.E2E_SKIP_SWAP !== "1") {
            const swapEnv: Record<string, string> = {
                ...baseEnv,
                MASP: this.addresses.masp,
                PERMIT2: this.addresses.permit2,
            };
            for (const [id, addr] of Object.entries(this.addresses.tokens)) {
                swapEnv[`TOKEN_${id}`] = addr;
            }
            const { stdout: swapOut } = await execFileAsync(
                "forge",
                [
                    "script", "script/DeployTestSwap.s.sol:DeployTestSwap",
                    "--rpc-url", rpcUrl,
                    "--private-key", DEPLOYER.privateKey,
                    "--broadcast",
                    "--disable-code-size-limit",
                ],
                {
                    cwd: CONTRACTS_DIR,
                    maxBuffer: 64 * 1024 * 1024,
                    env: swapEnv,
                },
            );
            const swap = parseSwapOutput(swapOut);
            this.addresses = { ...this.addresses, swap };
        }
        return this.addresses;
    }

    // Ingester runs alone first (owns schema migrations); the rest start in parallel.
    async upBackend(addrs: Addresses): Promise<Urls> {
        if (!this.network) throw new Error("upBackend: call up() first");
        const specs = backendSpecs(addrs.masp, addrs.swap, addrs.nativeAdapter);

        const ingester = await runService(specs.ingester, this.network);
        this.backends.push(ingester);

        const parallel: Promise<StartedTestContainer>[] = [
            runService(specs.fmdIndexer, this.network),
            runService(specs.explorerIndexer, this.network),
            runService(specs.fmdWeb, this.network),
            runService(specs.explorerWeb, this.network),
            runService(specs.relayer, this.network),
        ];
        if (specs.metaquoter) parallel.push(runService(specs.metaquoter, this.network));

        const started = await Promise.all(parallel);
        const [fmdIndexer, explorerIndexer, fmdWeb, explorerWeb, relayer, metaquoter] = started;
        this.backends.push(...started);

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
        const fs = await import("node:fs");
        const { execSync } = await import("node:child_process");
        // Final `docker logs` dump, written next to the streamed per-service
        // logs from `runService`. Both sinks used to be needed but landed in
        // different directories, so CI (which uploads only `E2E_LOG_DIR`) was
        // collecting half of them; keep them together.
        const logDir = process.env.E2E_LOG_DIR ?? "/tmp/e2e-logs";
        fs.mkdirSync(logDir, { recursive: true });
        for (const c of this.backends) {
            try {
                const id = (c as any).getId?.() ?? "";
                const name = ((c as any).getName?.() ?? "unknown").replace(/^\//, "");
                if (!id) continue;
                const out = execSync(`docker logs ${id} 2>&1 || true`, { maxBuffer: 64 * 1024 * 1024 });
                fs.writeFileSync(`${logDir}/${name}.docker.log`, out);
            } catch {}
        }
        const stops: Promise<unknown>[] = [];
        for (const c of [...this.backends, ...this.infra]) {
            stops.push(c.stop().catch(() => {}));
        }
        await Promise.all(stops);
        if (this.network) await this.network.stop().catch(() => {});
        this.backends = [];
        this.infra = [];
        this.network = undefined;
        this.addresses = undefined;
    }

    private rpcUrl(): string {
        const anvil = this.infra[1];
        if (!anvil) throw new Error("anvil not started");
        return `http://localhost:${anvil.getMappedPort(ANVIL.port!)}`;
    }
}

function hostUrl(c: StartedTestContainer, internalPort: number): string {
    return `http://localhost:${c.getMappedPort(internalPort)}`;
}

// Relayer mounts <e2e>/circuits/ at /circuits and reads tree_update_batch.{wasm,r1cs,_final.zkey}
// at startup. The fetch script is idempotent (skips if .version matches).
async function ensureCircuits(): Promise<void> {
    log("fetching circuits…");
    await execFileAsync("scripts/fetch-circuits.sh", [], { cwd: E2E_DIR });
}

function parseSwapOutput(stdout: string): SwapAddresses {
    const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const re = /\b(UNIV3_QUOTER|UNIV3_ADAPTER|MOCK_SWAP_ROUTER|SWAP_WRAPPER)=(0x[0-9a-fA-F]{40})/g;
    const found = new Map<string, string>();
    for (const m of stripped.matchAll(re)) found.set(m[1], m[2]);
    const need = ["UNIV3_QUOTER", "UNIV3_ADAPTER", "MOCK_SWAP_ROUTER", "SWAP_WRAPPER"];
    for (const k of need) {
        if (!found.has(k)) throw new Error(`swap deploy: missing ${k} in forge output:\n${stripped}`);
    }
    return {
        univ3Quoter: found.get("UNIV3_QUOTER")!,
        univ3Adapter: found.get("UNIV3_ADAPTER")!,
        mockSwapRouter: found.get("MOCK_SWAP_ROUTER")!,
        wrapper: found.get("SWAP_WRAPPER")!,
    };
}

function parseDeployOutput(stdout: string): Addresses {
    const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const re =
        /\b(TREE_UPDATE_BATCH_VERIFIER|VERIFIER|MASP|TOKEN_\d+|WRAPPED_NATIVE|NATIVE_ADAPTER|PERMIT2|UNIV3_QUOTER|UNIV3_ADAPTER|MOCK_SWAP_ROUTER|SWAP_WRAPPER)=(0x[0-9a-fA-F]{40})/g;
    const found = new Map<string, string>();
    for (const m of stripped.matchAll(re)) found.set(m[1], m[2]);

    for (const k of ["VERIFIER", "TREE_UPDATE_BATCH_VERIFIER", "MASP", "PERMIT2"]) {
        if (!found.has(k)) {
            throw new Error(`deploy: missing ${k} in forge output:\n${stripped}`);
        }
    }

    const tokens: Record<number, string> = {};
    for (const [k, v] of found) {
        const m = k.match(/^TOKEN_(\d+)$/);
        if (m) tokens[Number(m[1])] = v;
    }

    let swap: SwapAddresses | undefined;
    const swapKeys = ["UNIV3_QUOTER", "UNIV3_ADAPTER", "MOCK_SWAP_ROUTER", "SWAP_WRAPPER"];
    if (swapKeys.every((k) => found.has(k))) {
        swap = {
            univ3Quoter: found.get("UNIV3_QUOTER")!,
            univ3Adapter: found.get("UNIV3_ADAPTER")!,
            mockSwapRouter: found.get("MOCK_SWAP_ROUTER")!,
            wrapper: found.get("SWAP_WRAPPER")!,
        };
    } else if (swapKeys.some((k) => found.has(k))) {
        throw new Error(`deploy: partial swap addresses in forge output:\n${stripped}`);
    }

    return {
        verifier: found.get("VERIFIER")!,
        treeUpdateVerifier: found.get("TREE_UPDATE_BATCH_VERIFIER")!,
        masp: found.get("MASP")!,
        tokens,
        wrappedNative: found.get("WRAPPED_NATIVE"),
        nativeAdapter: found.get("NATIVE_ADAPTER"),
        permit2: found.get("PERMIT2")!,
        swap,
    };
}
