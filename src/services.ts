import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
    GenericContainer,
    type StartedNetwork,
    type StartedTestContainer,
    Wait,
    type WaitStrategy,
} from "testcontainers";

import { RELAYER } from "./accounts.js";
import {
    ANVIL_RPC_INTERNAL,
    BASE_RUST_ENV,
    CHAIN_ID,
    CIRCUITS_DIR,
    CONFIG_DIR,
    ORACLE_DIR,
    DB_URL,
    DEFAULT_STARTUP_MS,
    logDir,
    PORT,
} from "./infra/docker.js";
import { FEE_BPS } from "./protocol/amounts.js";
import { type FeeTokenSpec, renderRelayerConfig } from "./infra/relayer-config.js";
import { RELAYER_FEE_ADDRESS, RELAYER_FEE_IVK } from "./protocol/shielded-fee.js";
import type { SwapAddresses } from "./infra/addresses.js";

// Container specs for every backend service, plus the runner that starts one.
//
// `configFile` resolves against `CONFIG_DIR`; `hostPath` is an absolute host
// path, used for directory mounts such as the circuits.
export type MountSpec =
    | { configFile: string; target: string }
    | { hostPath: string; target: string };

export interface ServiceSpec {
    image: string;
    alias: string;
    env?: Record<string, string>;
    entrypoint?: string[];
    command?: string[];
    mounts?: MountSpec[];
    port?: number;
    wait: WaitStrategy;
    startupMs?: number;
}

export const POSTGRES: ServiceSpec = {
    image: "postgres:16-alpine",
    alias: "postgres",
    env: {
        POSTGRES_USER: "postgres",
        POSTGRES_PASSWORD: "postgres",
        POSTGRES_DB: "postgres",
    },
    port: PORT.POSTGRES,
    // postgres logs the ready line during init and again once fully online.
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

export interface BackendServices {
    ingester: ServiceSpec;
    fmdIndexer: ServiceSpec;
    explorerIndexer: ServiceSpec;
    fmdWeb: ServiceSpec;
    explorerWeb: ServiceSpec;
    relayer: ServiceSpec;
    metaquoter?: ServiceSpec;
}

/**
 * Static price feed for the relayer's fee quotes.
 *
 * nginx over `config/oracle`, whose tree mirrors the paths `CoinbaseOracle`
 * requests. `resp.json()` does not check content-type, so files served as
 * `application/octet-stream` parse correctly.
 */
export const ORACLE: ServiceSpec = {
    image: "nginx:alpine",
    alias: "oracle",
    mounts: [{ hostPath: ORACLE_DIR, target: "/usr/share/nginx/html" }],
    wait: Wait.forLogMessage(/start worker processes/),
};

/** Everything the backend containers need that only exists after the deploy. */
export interface BackendSpecArgs {
    masp: string;
    /** Mirrored into the relayer's `accepted_fee_tokens`; see `assets.ts`. */
    feeTokens: FeeTokenSpec[];
    /** Absent when the stack was brought up with `E2E_SKIP_SWAP=1`. */
    swap?: SwapAddresses;
    /** Absent when no wrapped-native token was deployed. */
    nativeAdapter?: string;
}

export function backendSpecs({
    masp,
    feeTokens,
    swap,
    nativeAdapter,
}: BackendSpecArgs): BackendServices {
    const relayerConfigPath = renderRelayerConfig(feeTokens);
    const services: BackendServices = {
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
            // Owns schema migrations. Backends started before this race it on
            // CREATE TYPE.
            wait: Wait.forLogMessage(/migrations complete/i),
        },
        fmdIndexer: {
            image: "lelantos/fmd-indexer:dev",
            alias: "fmd-indexer",
            env: BASE_RUST_ENV,
            // Exact line from `crates/fmd-indexer/src/main.rs`, emitted once
            // the config is loaded and the DB pool is built. Not `/ready/i`,
            // which matches any startup line containing the word and can
            // declare the container up before it has a database connection.
            wait: Wait.forLogMessage(/fmd-indexer ready/),
        },
        explorerIndexer: {
            image: "lelantos/explorer-indexer:dev",
            alias: "explorer-indexer",
            env: { ...BASE_RUST_ENV, EXPLORER_INDEXER_CONFIG: "/etc/explorer-indexer.toml" },
            mounts: [{ configFile: "explorer-indexer.toml", target: "/etc/explorer-indexer.toml" }],
            // `crates/explorer-indexer/src/main.rs`, after the pool is built.
            wait: Wait.forLogMessage(/explorer-indexer ready/),
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
                ...(swap
                    ? { [`RELAYER_CHAIN_${CHAIN_ID}_SWAP_WRAPPER_ADDRESS`]: swap.wrapper }
                    : {}),
                // Without it the relayer rejects `withdrawNative` payloads:
                // the pool is ERC-20 only, so the unwrap has no entry point.
                ...(nativeAdapter
                    ? { [`RELAYER_CHAIN_${CHAIN_ID}_NATIVE_ADAPTER_ADDRESS`]: nativeAdapter }
                    : {}),
                // Setting these makes the relayer charge for spends and
                // deposits. Both derive from one nsk, so the address and the
                // key cannot disagree; the relayer refuses to boot if they do.
                [`RELAYER_CHAIN_${CHAIN_ID}_SHIELDED_FEE_ADDRESS`]: RELAYER_FEE_ADDRESS,
                [`RELAYER_CHAIN_${CHAIN_ID}_SHIELDED_FEE_IVK`]: RELAYER_FEE_IVK,
                RUST_LOG: "info",
            },
            mounts: [
                // Rendered, not the committed file: `accepted_fee_tokens`
                // carries addresses that exist only after the forge deploy.
                { hostPath: relayerConfigPath, target: "/etc/relayer.toml" },
                { hostPath: CIRCUITS_DIR, target: "/circuits" },
            ],
            port: PORT.RELAYER,
            // `crates/relayer/src/main.rs` logs this only after the ark-circom
            // prover has loaded wasm/r1cs/zkey. Stronger than
            // `forListeningPorts()`: a relayer whose prover is still warming
            // accepts connections but stalls the first submit, which surfaces
            // much later as an unexplained `awaitOwn` timeout.
            wait: Wait.forLogMessage(/relayer listening/),
            // Prover load is slow in CI.
            startupMs: 90_000,
        },
    };

    if (swap) {
        services.metaquoter = {
            image: "lelantos/metaquoter:dev",
            alias: "metaquoter",
            env: {
                RUST_LOG: "info",
                METAQUOTER_CONFIG: "/etc/metaquoter.toml",
                [`METAQUOTER_CHAIN_${CHAIN_ID}_RPC_URL`]: ANVIL_RPC_INTERNAL,
                [`METAQUOTER_CHAIN_${CHAIN_ID}_UNIV3_QUOTER`]: swap.univ3Quoter,
                [`METAQUOTER_CHAIN_${CHAIN_ID}_UNIV3_ADAPTER`]: swap.univ3Adapter,
                [`METAQUOTER_CHAIN_${CHAIN_ID}_UNIV4_QUOTER`]: swap.univ4Quoter,
                [`METAQUOTER_CHAIN_${CHAIN_ID}_UNIV4_ADAPTER`]: swap.univ4Adapter,
                [`METAQUOTER_CHAIN_${CHAIN_ID}_MASP_FEE_BPS`]: FEE_BPS.toString(),
            },
            mounts: [{ configFile: "metaquoter.toml", target: "/etc/metaquoter.toml" }],
            port: PORT.METAQUOTER,
            wait: Wait.forListeningPorts(),
        };
    }

    return services;
}

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
                source: "hostPath" in m ? m.hostPath : resolve(CONFIG_DIR, m.configFile),
                target: m.target,
                mode: "ro" as const,
            })),
        );
    }

    // The container is reaped on failure, so logs are persisted to disk.
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    const sink = createWriteStream(resolve(dir, `${spec.alias}.log`), { flags: "a" });
    c = c.withLogConsumer(async (stream) => {
        stream.on("data", (line) => sink.write(line));
        stream.on("err", (line) => sink.write(line));
    });

    return c.start();
}
