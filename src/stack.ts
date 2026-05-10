// Lifecycle for the programmatic e2e stack. Owns container starts, the
// host-side `forge` deploy, and shutdown. Service shape lives in
// `services.ts`; deterministic accounts in `accounts.ts`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
    Network,
    type StartedNetwork,
    type StartedTestContainer,
} from "testcontainers";

import { DEPLOYER, PAYER, RECIPIENT } from "./accounts";
import { CHAIN_ID, CONTRACTS_DIR, FEE_BPS } from "./constants";
import { CANONICAL_PERMIT2_ADDRESS, preDeployPermit2 } from "./permit2";
import { ANVIL, backendSpecs, POSTGRES, runService } from "./services";

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

export interface Addresses {
    verifier: string;
    treeUpdateVerifier: string;
    masp: string;
    /// Token id (from the asset registry) → ERC20 address.
    tokens: Record<number, string>;
    weth?: string;
    /// Uniswap Permit2 deployment used by MASP for deposit pulls.
    permit2: string;
    /// Populated only when `Stack.deploy({ withSwap: true })` is requested.
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
    /// Populated only when the swap stack is deployed (and the metaquoter
    /// container started).
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
    swap?: SwapAddresses;
}


// ──────────────────────────────────────────────────────────────────────
// Stack
// ──────────────────────────────────────────────────────────────────────

export class Stack {
    private network?: StartedNetwork;
    private infra: StartedTestContainer[] = []; // [postgres, anvil]
    private backends: StartedTestContainer[] = [];
    private addresses?: Addresses;

    /// Phase 1 — postgres + anvil. Returns the host-mapped RPC URL; the
    /// rest of `Urls` is populated by `upBackend()`.
    async up(): Promise<{ rpc: string }> {
        this.network = await new Network().start();

        const postgres = await runService(POSTGRES, this.network);
        const anvil = await runService(ANVIL, this.network);
        this.infra = [postgres, anvil];

        // Pre-deploy canonical Permit2. DeployTest.s.sol's `DeployPermit2`
        // lib only `vm.etch`s the bytecode (cheatcode-local), which gets
        // dropped under `--broadcast` simulation; MASP ctor then reverts
        // ZeroPermit2() because `permit2.code.length == 0` on-chain.
        await preDeployPermit2(this.rpcUrl());

        return { rpc: this.rpcUrl() };
    }

    /// Phase 2 — host-side forge deploy. Always deploys the swap stack
    /// (MockQuoterV2 + MockSwapRouter02 + UniV3Adapter + SwapWrapper)
    /// alongside MASP. Parses DeployTest.s.sol's KEY=0xADDR stdout into a
    /// typed `Addresses`.
    async deploy(): Promise<Addresses> {
        const rpcUrl = this.rpcUrl();
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            MASP_FEE_BPS: FEE_BPS.toString(),
            SWAP_ENABLED: "true",
            // `preDeployPermit2` (run in `up()`) puts canonical Permit2
            // bytecode at this address. Tell DeployTest about it so it
            // skips the `vm.getCode` deploy fallback.
            PERMIT2: CANONICAL_PERMIT2_ADDRESS,
        };

        const { stdout } = await execFileAsync(
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
                env,
            },
        );

        this.addresses = parseDeployOutput(stdout);
        return this.addresses;
    }

    /// Phase 3 — backend services. Ingester runs alone first (it owns the
    /// schema-creating migrations); the remaining five start in parallel
    /// once the schema is in place.
    async upBackend(addrs: Addresses): Promise<Urls> {
        if (!this.network) throw new Error("upBackend: call up() first");
        const specs = backendSpecs(addrs.masp, addrs.swap);

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
            swap: this.addresses.swap,
        };
    }

    async down(): Promise<void> {
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

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function hostUrl(c: StartedTestContainer, internalPort: number): string {
    return `http://localhost:${c.getMappedPort(internalPort)}`;
}

function parseDeployOutput(stdout: string): Addresses {
    const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const re =
        /\b(TREE_UPDATE_BATCH_VERIFIER|VERIFIER|MASP|TOKEN_\d+|WETH|PERMIT2|UNIV3_QUOTER|UNIV3_ADAPTER|MOCK_SWAP_ROUTER|SWAP_WRAPPER)=(0x[0-9a-fA-F]{40})/g;
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
        weth: found.get("WETH"),
        permit2: found.get("PERMIT2")!,
        swap,
    };
}
