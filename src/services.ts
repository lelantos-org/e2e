// Declarative service specs for the e2e stack. One row per container,
// one helper to start a row. Adding/changing a service is a data edit —
// the imperative orchestration in stack.ts stays small.

import { resolve } from "node:path";

import {
    GenericContainer,
    type StartedNetwork,
    type StartedTestContainer,
    Wait,
    type WaitStrategy,
} from "testcontainers";

import { RELAYER } from "./accounts";
import {
    ANVIL_RPC_INTERNAL,
    BASE_RUST_ENV,
    CHAIN_ID,
    CONFIG_DIR,
    DB_URL,
    DEFAULT_STARTUP_MS,
    PORT,
} from "./constants";

// ──────────────────────────────────────────────────────────────────────
// Spec shape
// ──────────────────────────────────────────────────────────────────────

export interface MountSpec {
    /// File name under e2e/config/ (resolved into an absolute path).
    configFile: string;
    /// Path inside the container.
    target: string;
}

export interface ServiceSpec {
    image: string;
    /// Network alias other services use to reach this one (e.g. `postgres`,
    /// `anvil`, `relayer`).
    alias: string;
    env?: Record<string, string>;
    /// Optional shell-style entrypoint + command (anvil overrides ENTRYPOINT).
    entrypoint?: string[];
    command?: string[];
    /// Read-only bind mounts; `source` resolved against `e2e/config/`.
    mounts?: MountSpec[];
    /// Internal port to expose to the host. `getMappedPort(port)` returns
    /// the host-side ephemeral mapping.
    port?: number;
    wait: WaitStrategy;
    startupMs?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Infra: postgres + anvil
// ──────────────────────────────────────────────────────────────────────

export const POSTGRES: ServiceSpec = {
    image: "postgres:16-alpine",
    alias: "postgres",
    env: {
        POSTGRES_USER: "postgres",
        POSTGRES_PASSWORD: "postgres",
        POSTGRES_DB: "postgres",
    },
    port: PORT.POSTGRES,
    // postgres logs `database system is ready to accept connections` once
    // during init and again when fully online; wait for the second.
    wait: Wait.forLogMessage(/database system is ready to accept connections/, 2),
};

export const ANVIL: ServiceSpec = {
    image: "ghcr.io/foundry-rs/foundry:stable",
    alias: "anvil",
    entrypoint: ["anvil"],
    command: [
        "--host=0.0.0.0",
        "--port=8545",
        `--chain-id=${CHAIN_ID}`,
        "--hardfork=cancun",
        "--disable-code-size-limit",
        "--gas-limit=5000000000",
        "--block-time=1",
        "--mnemonic=test test test test test test test test test test test junk",
    ],
    port: PORT.ANVIL,
    wait: Wait.forLogMessage(/Listening on 0\.0\.0\.0:8545/),
};

// ──────────────────────────────────────────────────────────────────────
// Backend services. `masp` is the only deploy-time address backends
// need; the rest live in their config TOMLs.
// ──────────────────────────────────────────────────────────────────────

export interface BackendServices {
    ingester: ServiceSpec;
    fmdIndexer: ServiceSpec;
    explorerIndexer: ServiceSpec;
    fmdWeb: ServiceSpec;
    explorerWeb: ServiceSpec;
    relayer: ServiceSpec;
}

export function backendSpecs(masp: string): BackendServices {
    return {
        ingester: {
            image: "lelantos/ingester:dev",
            alias: "ingester",
            env: {
                ...BASE_RUST_ENV,
                INGESTER_CONFIG: "/etc/ingester.toml",
                [`INGESTER_CHAIN_${CHAIN_ID}_POOL_ADDRESS`]: masp,
                [`INGESTER_CHAIN_${CHAIN_ID}_RPC_URL`]: ANVIL_RPC_INTERNAL,
                [`INGESTER_CHAIN_${CHAIN_ID}_START_BLOCK`]: "0",
            },
            mounts: [{ configFile: "ingester.toml", target: "/etc/ingester.toml" }],
            // Ingester owns the schema-creating migrations. Wait until they
            // finish so concurrent backends don't race CREATE TYPE.
            wait: Wait.forLogMessage(/migrations complete/i),
        },
        fmdIndexer: {
            image: "lelantos/fmd-indexer:dev",
            alias: "fmd-indexer",
            env: BASE_RUST_ENV,
            wait: Wait.forLogMessage(/tick driver started|ready/i),
        },
        explorerIndexer: {
            image: "lelantos/explorer-indexer:dev",
            alias: "explorer-indexer",
            env: { ...BASE_RUST_ENV, EXPLORER_INDEXER_CONFIG: "/etc/explorer-indexer.toml" },
            mounts: [{ configFile: "explorer-indexer.toml", target: "/etc/explorer-indexer.toml" }],
            wait: Wait.forLogMessage(/tick driver started|ready/i),
        },
        fmdWeb: {
            image: "lelantos/fmd-webserver:dev",
            alias: "fmd-webserver",
            env: { ...BASE_RUST_ENV, BIND_ADDR: `0.0.0.0:${PORT.FMD_WEB}` },
            port: PORT.FMD_WEB,
            wait: Wait.forListeningPorts(),
        },
        explorerWeb: {
            image: "lelantos/explorer-webserver:dev",
            alias: "explorer-webserver",
            env: { ...BASE_RUST_ENV, EXPLORER_BIND_ADDR: `0.0.0.0:${PORT.EXPLORER_WEB}` },
            port: PORT.EXPLORER_WEB,
            wait: Wait.forListeningPorts(),
        },
        relayer: {
            image: "lelantos/relayer:dev",
            alias: "relayer",
            env: {
                DATABASE_URL: DB_URL,
                RELAYER_CONFIG: "/etc/relayer.toml",
                [`RELAYER_CHAIN_${CHAIN_ID}_POOL_ADDRESS`]: masp,
                [`RELAYER_CHAIN_${CHAIN_ID}_RPC_URL`]: ANVIL_RPC_INTERNAL,
                [`RELAYER_CHAIN_${CHAIN_ID}_SIGNER_KEY`]: RELAYER.privateKey,
                RUST_LOG: "info",
            },
            mounts: [{ configFile: "relayer.toml", target: "/etc/relayer.toml" }],
            port: PORT.RELAYER,
            wait: Wait.forListeningPorts(),
        },
    };
}

// ──────────────────────────────────────────────────────────────────────
// Spec → running container
// ──────────────────────────────────────────────────────────────────────

export async function runService(
    spec: ServiceSpec,
    network: StartedNetwork,
): Promise<StartedTestContainer> {
    let c = new GenericContainer(spec.image)
        .withNetwork(network)
        .withNetworkAliases(spec.alias)
        .withWaitStrategy(spec.wait)
        .withStartupTimeout(spec.startupMs ?? DEFAULT_STARTUP_MS);
    if (spec.entrypoint) c = c.withEntrypoint(spec.entrypoint);
    if (spec.command) c = c.withCommand(spec.command);
    if (spec.env) c = c.withEnvironment(spec.env);
    if (spec.port != null) c = c.withExposedPorts(spec.port);
    if (spec.mounts) {
        c = c.withBindMounts(
            spec.mounts.map((m) => ({
                source: resolve(CONFIG_DIR, m.configFile),
                target: m.target,
                mode: "ro" as const,
            })),
        );
    }
    return c.start();
}
