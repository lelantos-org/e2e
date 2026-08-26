// Container-side wiring: ports, in-network hostnames, and the host paths that
// are bind-mounted. Consumed only by `services.ts` and `stack.ts`; no test
// imports from here.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHAIN_ID = "31337";

// This package is ESM ("type": "module"); `__dirname` does not exist.
export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONFIG_DIR = resolve(E2E_DIR, "config");
export const CIRCUITS_DIR = resolve(E2E_DIR, "circuits");
export const ORACLE_DIR = resolve(CONFIG_DIR, "oracle");
const VENDOR_DIR = resolve(E2E_DIR, "vendor");
export const CONTRACTS_DIR = resolve(VENDOR_DIR, "contracts");

/**
 * Where per-service logs are written.
 *
 * Both sinks that produce them — `runService`'s live stream and `Stack.down`'s
 * final `docker logs` dump — must resolve it through here, so that CI (which
 * uploads only `E2E_LOG_DIR`) collects all of them.
 */
export function logDir(): string {
    return process.env.E2E_LOG_DIR ?? "/tmp/e2e-logs";
}

// Hostname matches the `postgres` network alias set in `services.ts`.
export const DB_URL = "postgres://postgres:postgres@postgres:5432/postgres";

// Backend-container URL. Host-side tests use the ephemeral mapped port.
export const ANVIL_RPC_INTERNAL = "http://anvil:8545";

export const PORT = {
    POSTGRES: 5432,
    ANVIL: 8545,
    FMD_WEB: 3001,
    EXPLORER_WEB: 3002,
    RELAYER: 3003,
    METAQUOTER: 8081,
} as const;

export const BASE_RUST_ENV = {
    DATABASE_URL: DB_URL,
    RUST_LOG: "info,sqlx=warn",
} as const;

export const DEFAULT_STARTUP_MS = 60_000;
