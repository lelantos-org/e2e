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
import { CHAIN_ID, CONTRACTS_DIR } from "./constants";
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
}

export interface Urls {
    rpc: string;
    relayer: string;
    fmd: string;
    explorer: string;
}

export interface StackEnv extends Urls {
    chainId: string;
    masp: string;
    tokens: Record<number, string>;
    payerAddress: string;
    payerKey: string;
    recipientAddress: string;
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

        return { rpc: this.rpcUrl() };
    }

    /// Phase 2 — host-side forge deploy. Parses Deploy.s.sol's
    /// KEY=0xADDR stdout into a typed `Addresses`.
    async deploy(): Promise<Addresses> {
        const rpcUrl = this.rpcUrl();
        const { stdout } = await execFileAsync(
            "forge",
            [
                "script", "script/Deploy.s.sol",
                "--rpc-url", rpcUrl,
                "--private-key", DEPLOYER.privateKey,
                "--broadcast",
                "--disable-code-size-limit",
            ],
            { cwd: CONTRACTS_DIR, maxBuffer: 64 * 1024 * 1024 },
        );

        this.addresses = parseDeployOutput(stdout);
        return this.addresses;
    }

    /// Phase 3 — backend services. Ingester runs alone first (it owns the
    /// schema-creating migrations); the remaining five start in parallel
    /// once the schema is in place.
    async upBackend(addrs: Addresses): Promise<Urls> {
        if (!this.network) throw new Error("upBackend: call up() first");
        const specs = backendSpecs(addrs.masp);

        const ingester = await runService(specs.ingester, this.network);
        this.backends.push(ingester);

        const [fmdIndexer, explorerIndexer, fmdWeb, explorerWeb, relayer] =
            await Promise.all([
                runService(specs.fmdIndexer, this.network),
                runService(specs.explorerIndexer, this.network),
                runService(specs.fmdWeb, this.network),
                runService(specs.explorerWeb, this.network),
                runService(specs.relayer, this.network),
            ]);
        this.backends.push(fmdIndexer, explorerIndexer, fmdWeb, explorerWeb, relayer);

        return {
            rpc: this.rpcUrl(),
            fmd: hostUrl(fmdWeb, specs.fmdWeb.port!),
            explorer: hostUrl(explorerWeb, specs.explorerWeb.port!),
            relayer: hostUrl(relayer, specs.relayer.port!),
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
    const re = /(VERIFIER|TREE_UPDATE_VERIFIER|MASP|TOKEN_\d+|WETH)=(0x[0-9a-fA-F]{40})/g;
    const found = new Map<string, string>();
    for (const m of stripped.matchAll(re)) found.set(m[1], m[2]);

    for (const k of ["VERIFIER", "TREE_UPDATE_VERIFIER", "MASP"]) {
        if (!found.has(k)) {
            throw new Error(`deploy: missing ${k} in forge output:\n${stripped}`);
        }
    }

    const tokens: Record<number, string> = {};
    for (const [k, v] of found) {
        const m = k.match(/^TOKEN_(\d+)$/);
        if (m) tokens[Number(m[1])] = v;
    }

    return {
        verifier: found.get("VERIFIER")!,
        treeUpdateVerifier: found.get("TREE_UPDATE_VERIFIER")!,
        masp: found.get("MASP")!,
        tokens,
        weth: found.get("WETH"),
    };
}
