import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type AssetId, assetId, type CircuitAmount, circuitAmount } from "@lelantos-org/sdk";

export const CHAIN_ID = "31337";

// This package is ESM ("type": "module"), where `__dirname` does not exist.
export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_DIR = resolve(E2E_DIR, "config");
export const CIRCUITS_DIR = resolve(E2E_DIR, "circuits");
export const VENDOR_DIR = resolve(E2E_DIR, "vendor");
export const CONTRACTS_DIR = resolve(VENDOR_DIR, "contracts");

/**
 * Where per-service logs are written.
 *
 * Both sinks that produce them — `runService`'s live stream and `Stack.down`'s
 * final `docker logs` dump — must agree on this. They used to default
 * independently and drifted apart, so CI (which uploads only `E2E_LOG_DIR`)
 * collected half of them.
 */
export function logDir(): string {
    return process.env.E2E_LOG_DIR ?? "/tmp/e2e-logs";
}

// Hostname matches the `postgres` network alias set in `services.ts`.
export const DB_URL = "postgres://postgres:postgres@postgres:5432/postgres";

// Backend-container URL; host-side tests use the ephemeral mapped port.
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

/**
 * How long the suite's internal polls wait before giving up. Not per-test
 * budgets — those are `TEST_TIMEOUT`.
 */
export const TIMEOUT = {
    POLL_DEFAULT_MS: 120_000,
    BATCH_FLUSH_MS: 150_000,
    BALANCE_POLL_MS: 150_000,
    /**
     * How long to watch for a deposit's flush event. Several relayer ticks
     * (`flush_interval_s`), so a deposit that just missed one is covered.
     * Advisory only — the note-cache poll is what decides pass or fail.
     */
    DEPOSIT_FLUSH_MS: 60_000,
} as const;

/**
 * Per-`it` budgets, passed as vitest's timeout argument. Named by what the
 * test actually waits on, so a slow CI run is retuned in one place.
 */
export const TEST_TIMEOUT = {
    /** One spend: proof + chain inclusion + indexer pickup. */
    SPEND: 240_000,
    /** A swap — as above plus the relayer-flushed second leg. */
    SWAP: 360_000,
    /** A multi-transaction narrative inside a single `it`. */
    SEQUENCE: 600_000,
    /** Reads settled state only; no chain round trip. */
    LOCAL: 60_000,
    /** N parallel deposits plus a relayer flush tick. */
    BATCH_FLUSH: 240_000,
} as const;

// Page sizes for the shared indexes. Test files share one fmd index, so these
// are a silent correctness cliff: once the index holds more rows than this, a
// freshly written note can be buried behind older pages and a `sync()` that
// "found nothing" is really "looked at the wrong page". Named so that a suite
// growing past them is a visible edit rather than a mysterious flake.
export const SYNC_LIMIT = 200;
// fmd-webserver caps `listNotes` at 1000 rows; ask for the max.
export const LIST_LIMIT = 1000;

export interface PollOpts {
    maxAttempts: number;
    pollMs: number;
}

/**
 * Picked by `awaitOwn`/`awaitRecipient` based on the tx kind. Override
 * per-call by passing a `PollOpts` to either helper. `COMMITMENT` covers
 * the relayer flush window (slow); `SPEND` is the spend pipeline path.
 */
export const POLL: Record<"COMMITMENT" | "SPEND", PollOpts> = {
    COMMITMENT: { maxAttempts: 80, pollMs: 2000 },
    SPEND:      { maxAttempts: 60, pollMs: 1500 },
} as const;

// Must match `circuits/3x3.circom` `Transact(N_IN, N_OUT, GAMMA, DEPTH)`.
export const TREE_DEPTH = 10;

// Circuit arity. `PubInputs.TRANSACT_IN` / `TRANSACT_OUT` in the contracts and
// `TRANSACT_3X3` in the SDK; all three must agree or the verifier rejects.
export const N_IN = 3;
export const N_OUT = 3;

// FMD γ. False-positive rate = 2^-γ. Must match asset registry + circuit.
export const FMD_GAMMA = 5;

// Mirrors `contracts/test/fixtures/asset_registry.json`. Branded at the source:
// the SDK wallet surface takes `AssetId`, and the brand widens back to `bigint`
// for the local scale/fee helpers and for `bundleCommon`.
export const ASSETS = {
    WETH: assetId(1n),  // WETH9 mock — no public `mint(address,uint256)`; use `setupWeth`.
    MDAI: assetId(2n),  // MockERC20 with public mint; default for fee/scale helpers.
    MWBTC: assetId(3n), // MockERC20, scale = 1 (8-decimal).
} as const;

// Default asset for feeFor/baseAmt/withFee.
export const ASSET: AssetId = ASSETS.MDAI;

/**
 * Circuit-unit amount literal. The SDK wallet takes `CircuitAmount`; tests
 * deal in whole units, so this is the shorthand at every call site.
 */
export const amt = (v: bigint): CircuitAmount => circuitAmount(v);

// Burn / non-allowlisted adapter sentinel for negative tests.
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

// 500 bps = 5%. Threaded into `DeployTest.s.sol` via `MASP_FEE_BPS`.
export const FEE_BPS = 500n;

// Mirrors `contracts/test/fixtures/asset_registry.json`.
export const SCALES: Record<string, bigint> = {
    "1": 10_000_000_000n, // WETH (18 dec)
    "2": 10_000_000_000n, // mDAI (18 dec)
    "3": 1n,              // mWBTC (8 dec)
};

export function scaleFor(asset: bigint): bigint {
    const s = SCALES[asset.toString()];
    if (s === undefined) throw new Error(`scaleFor: unknown asset id ${asset}`);
    return s;
}

export function baseAmt(amount: bigint, asset: bigint = ASSET): bigint {
    return amount * scaleFor(asset);
}

// Matches contract math: fee = (publicIn * scale * feeBps) / 10000.
export function feeFor(amount: bigint, asset: bigint = ASSET): bigint {
    const inAmt = amount * scaleFor(asset);
    return (inAmt * FEE_BPS) / 10000n;
}

export function withFee(amount: bigint, asset: bigint = ASSET): bigint {
    return amount * scaleFor(asset) + feeFor(amount, asset);
}

/**
 * Fee in *circuit* units, for amounts that never get scaled to base units —
 * the debit a withdraw takes off a shielded balance, say. Mirrors the SDK's
 * `applyFee`; `feeFor` is the base-unit equivalent and scales first, so the
 * two are not interchangeable (they floor at different magnitudes).
 */
export function circuitFee(amount: bigint): bigint {
    return (amount * FEE_BPS) / 10_000n;
}

export const MASP_ABI = [
    "function isKnownRoot(bytes32) view returns (bool)",
    "function currentRoot() view returns (bytes32)",
    "function committedCount() view returns (uint64)",
    "function spent(bytes32) view returns (bool)",
    "function feeBps() view returns (uint16)",
    "function treasury() view returns (address)",
    "function accruedFee(address) view returns (uint256)",
    "event DepositFlushed(uint256 indexed id, bytes32 cm)",
    "event NotePayload(bytes32 indexed cm, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint256 cvDepX, uint256 cvDepY)",
    "event RootAdvanced(uint64 indexed startIndex, uint64 inserted, bytes32 oldRoot, bytes32 newRoot)",
] as const;

export const MOCK_ERC20_ABI = [
    "function mint(address to, uint256 amount) public",
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function balanceOf(address) view returns (uint256)",
] as const;

export const MOCK_WETH9_ABI = [
    "function deposit() payable",
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function balanceOf(address) view returns (uint256)",
] as const;

// deposit + cancelDeposit + DepositEscrowed event; separated from MASP_ABI
// because submitDepositDirect bypasses the SDK Wallet path.
//
// A deposit occupies exactly one leaf: `outCm` is a single `bytes32` and the
// leaf's Pedersen anchor is `(cvDep, rcv)` — the old `cvDep0/cvDep1/rcvTotal`
// triple existed only to pin a zero-value pad leaf the contract now collapses.
export const MASP_DEPOSIT_ABI = [
    "function deposit((uint256 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32 outCm,uint256[2] cvDep,uint256 rcv) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) aux) returns (uint256)",
    "function depositAuthorized((uint256 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32 outCm,uint256[2] cvDep,uint256 rcv) d, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) aux) returns (uint256)",
    "function cancelDeposit(uint256 id, uint48 publicIn, bytes32 cm, uint256[2] cvDep, uint64 publicAssetId, uint16 fbps, address payer, uint32 submittedAt)",
    "function cancelDelay() view returns (uint32)",
    "error SignatureExpired(uint256 signatureDeadline)",
    "error MustHaveDeposit()",
    "event DepositEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 cm, uint256 cvDepX, uint256 cvDepY, uint256 rcv, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext)",
    "event DepositFlushed(uint256 indexed id, bytes32 cm)",
] as const;

export const MOCK_QUOTER_V2_ABI = [
    "function set(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint256 gasEstimate)",
] as const;

export const MOCK_SWAP_ROUTER_ABI = [
    "function setNextOut(uint256 v)",
    "function nextOut() view returns (uint256)",
] as const;

/**
 * Rejection reasons, matched by `expectRevert`.
 *
 * Each entry names the specific guard its test is about. Where more than one
 * alternative is listed they are all *named states of that same guard* (the
 * relayer's pre-check versus the pool's on-chain check, say) — never a
 * catch-all like `/reverted/i`, which would let a misconfigured harness pass
 * a negative test without exercising anything.
 *
 * Contract error names come from `vendor/contracts`; relayer messages from
 * `AppError` in `vendor/backend/crates/relayer/src/domain/error.rs`. Selectors
 * are decoded by `KNOWN_SELECTORS` in `utils.ts` for the cases where ethers
 * surfaces raw `data` from a sub-call.
 *
 * Note there is no entry for the swap wrapper's guards: the relayer collapses
 * every submit-time swap revert to an opaque `HTTP 500: internal error`, so
 * `AdapterNotAllowed` and the router's under-delivery revert never reach a
 * client. `tests/swap.test.ts` asserts on effects instead, and says so.
 */
export const REVERT = {
    /**
     * A spend of an already-published nullifier. Two layers can catch it and
     * which one does is a timing detail, so both named states are accepted:
     * the relayer rejects with `AppError::NullifierAlreadySpent` (HTTP 409,
     * `crates/relayer/src/domain/error.rs`) as soon as it has seen the first
     * spend, and only a request that gets past it reaches the pool's
     * `NullifierSet.DoubleSpend()`. In practice the relayer wins.
     */
    NULLIFIER_SPENT: /nullifier already spent|DoubleSpend/,
    /**
     * The loser of a race between two spends of one note. Same guard as
     * above, but the winner has not been indexed yet, so the relayer reports
     * the nullifier as in flight rather than spent. Both outcomes are correct
     * and which one appears depends on how far the loser got.
     */
    NULLIFIER_CONTESTED: /nullifier in flight|nullifier already spent|DoubleSpend/,
    /**
     * Permit2 `InvalidAmount(uint256)` — requestedAmount exceeds the signed
     * `permitted.amount` (our `sig.maxTotal`).
     */
    PERMIT2_INVALID_AMOUNT: /InvalidAmount/,
    /** Permit2 `SignatureExpired(uint256)`. */
    PERMIT2_EXPIRED: /SignatureExpired/,
    /**
     * `SwapWrapper.AdapterNotAllowed()` — adapter is not on the allowlist.
     * Reaches the client as the relayer's `ContractRejected` (HTTP 400),
     * which echoes the contract's revert data; the selector is decoded by
     * `KNOWN_SELECTORS` in `utils.ts`.
     */
    ADAPTER_NOT_ALLOWED: /AdapterNotAllowed/,
    /**
     * The *router* rejects first: `UniV3Adapter` forwards `minOut` as
     * `amountOutMinimum`, so `MockSwapRouter02`'s require trips before
     * `SwapWrapper.InsufficientOut` is ever reached. Matching the wrapper's
     * error here would silently never fire.
     */
    SWAP_UNDER_MIN_OUT: /too little received/,
} as const;

// Full SwapArgs calldata layout lives in `swap-harness.ts`.
export const SWAP_WRAPPER_ABI = [
    "function adapterAllowed(address) view returns (bool)",
    "event SwapExecuted(address indexed adapter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 actualOut, uint256 dust, uint256 depositId)",
] as const;
