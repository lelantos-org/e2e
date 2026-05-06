// Single source of truth for every magic value the e2e runner needs.
// Anything that's a literal somebody else might want to change — chain
// id, ports, paths, ABIs, timeouts, gamma — lives here.
//
// Splits:
//   - chain      : CHAIN_ID
//   - paths      : REPO_ROOT, E2E_DIR, CONFIG_DIR, CONTRACTS_DIR, CIRCUITS_BUILD_DIR
//   - network    : DB_URL, ANVIL_RPC_INTERNAL, container ports
//   - rust env   : BASE_RUST_ENV (DATABASE_URL + RUST_LOG)
//   - runtime    : DEFAULT_STARTUP_MS
//   - test domain: TREE_DEPTH, FMD_GAMMA, ASSET (mDAI id)
//   - solidity   : MASP_ABI, MOCK_ERC20_ABI

import { resolve } from "node:path";

// ──────────────────────────────────────────────────────────────────────
// Chain
// ──────────────────────────────────────────────────────────────────────

/// EVM chain id baked into anvil + every backend's `*_CHAIN_<id>_*` env
/// var name. Changing this requires regenerating the asset-registry
/// fixture so `pubAssetGen` matches the new chain.
export const CHAIN_ID = "31337";

// ──────────────────────────────────────────────────────────────────────
// Paths (host)
// ──────────────────────────────────────────────────────────────────────

// src/constants.ts → src → e2e → repo
export const E2E_DIR = resolve(__dirname, "..");
export const REPO_ROOT = resolve(E2E_DIR, "..");
export const CONFIG_DIR = resolve(E2E_DIR, "config");
export const CONTRACTS_DIR = resolve(REPO_ROOT, "contracts");
export const CIRCUITS_BUILD_DIR = resolve(REPO_ROOT, "circuits", "build");

// ──────────────────────────────────────────────────────────────────────
// Container network
// ──────────────────────────────────────────────────────────────────────

/// Connection string used by every backend container. Hostname matches
/// the `postgres` network alias set in `services.ts`.
export const DB_URL = "postgres://postgres:postgres@postgres:5432/postgres";

/// Anvil RPC URL backend containers use over the testcontainers network
/// (host-side tests use the ephemeral mapped port from `Stack.up()`).
export const ANVIL_RPC_INTERNAL = "http://anvil:8545";

/// Internal container ports. Host side gets ephemeral mapped ports via
/// `getMappedPort(internal)`.
export const PORT = {
    POSTGRES: 5432,
    ANVIL: 8545,
    FMD_WEB: 3001,
    EXPLORER_WEB: 3002,
    RELAYER: 3003,
} as const;

// ──────────────────────────────────────────────────────────────────────
// Rust env shared by every backend
// ──────────────────────────────────────────────────────────────────────

export const BASE_RUST_ENV = {
    DATABASE_URL: DB_URL,
    RUST_LOG: "info,sqlx=warn",
} as const;

// ──────────────────────────────────────────────────────────────────────
// Runtime
// ──────────────────────────────────────────────────────────────────────

/// Per-container startup timeout. Cold image pull + DB migrate + chain
/// connect should finish well under 60s; bump if your runner is slow.
export const DEFAULT_STARTUP_MS = 60_000;

// ──────────────────────────────────────────────────────────────────────
// Test-domain knobs
// ──────────────────────────────────────────────────────────────────────

/// Quaternary commitment-tree depth — must match `circuits/2x2.circom`
/// `Transact(N_IN, N_OUT, GAMMA, DEPTH)`.
export const TREE_DEPTH = 10;

/// FMD γ. False-positive rate = 2^-γ. Must match the value the asset
/// registry + circuit were compiled against.
export const FMD_GAMMA = 5;

/// Asset id 2 = mDAI (plain MockERC20). Id 1 is WETH9 mock with no
/// public `mint(address,uint256)` selector, so the runner mints into
/// the mDAI slot.
export const ASSET = 2n;

// ──────────────────────────────────────────────────────────────────────
// Solidity ABIs
// ──────────────────────────────────────────────────────────────────────

export const MASP_ABI = [
    "function isKnownRoot(bytes32) view returns (bool)",
    "function currentRoot() view returns (bytes32)",
    "function committedCount() view returns (uint64)",
    "function spent(bytes32) view returns (bool)",
] as const;

export const MOCK_ERC20_ABI = [
    "function mint(address to, uint256 amount) public",
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function balanceOf(address) view returns (uint256)",
] as const;
