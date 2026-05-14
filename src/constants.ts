import { resolve } from "node:path";

export const CHAIN_ID = "31337";

export const E2E_DIR = resolve(__dirname, "..");
export const CONFIG_DIR = resolve(E2E_DIR, "config");
export const CIRCUITS_DIR = resolve(E2E_DIR, "circuits");
export const VENDOR_DIR = resolve(E2E_DIR, "vendor");
export const CONTRACTS_DIR = resolve(VENDOR_DIR, "contracts");

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

export const TIMEOUT = {
    POLL_DEFAULT_MS: 120_000,
    BATCH_FLUSH_MS: 150_000,
    BATCH_FLUSH_TEST_MS: 240_000,
} as const;

export const POLL = {
    COMMITMENT:   { maxAttempts: 80, pollMs: 2000 },
    SPEND:        { maxAttempts: 60, pollMs: 1500 },
    ROOT_ADVANCE: { maxAttempts: 60, pollMs: 2500 },
    RELAYER_TX:   { maxAttempts: 60, pollMs: 2500 },
} as const;

// Must match `circuits/2x2.circom` `Transact(N_IN, N_OUT, GAMMA, DEPTH)`.
export const TREE_DEPTH = 10;

// FMD γ. False-positive rate = 2^-γ. Must match asset registry + circuit.
export const FMD_GAMMA = 5;

// Mirrors `contracts/test/fixtures/asset_registry.json`.
export const ASSETS = {
    WETH: 1n,  // WETH9 mock — no public `mint(address,uint256)`; use `setupWeth`.
    MDAI: 2n,  // MockERC20 with public mint; default for fee/scale helpers.
    MWBTC: 3n, // MockERC20, scale = 1 (8-decimal).
} as const;

// Default asset for feeFor/baseAmt/withFee.
export const ASSET = ASSETS.MDAI;

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

export const MASP_ABI = [
    "function isKnownRoot(bytes32) view returns (bool)",
    "function currentRoot() view returns (bytes32)",
    "function committedCount() view returns (uint64)",
    "function spent(bytes32) view returns (bool)",
    "function feeBps() view returns (uint16)",
    "function treasury() view returns (address)",
    "function accruedFee(address) view returns (uint256)",
    "function verifyProof(tuple(uint256[2] a, uint256[2][2] b, uint256[2] c) p, tuple(bytes32 merkleRoot, bytes32[2] nullifier, bytes32[2] outCm, uint64 publicAssetId, uint64 publicIn, uint64 publicOut, uint256[2][2] inCv, uint256[2][2] outCv, address recipient, uint256 chainId, address payer, address relayer, uint256[2][2] outCvDep) pi, tuple(uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext)[2] aux) view returns (bool)",
    "function VERIFIER() view returns (address)",
    "event IntentFlushed(uint256 indexed id, bytes32 cm0, bytes32 cm1)",
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

// submitIntent + cancelIntent + IntentEscrowed event; separated from MASP_ABI
// because submitIntentDirect bypasses the SDK Wallet path.
export const MASP_INTENT_ABI = [
    "function submitIntent((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function cancelIntent(uint256 id)",
    "function cancelDelay() view returns (uint32)",
    "event IntentEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, bytes32 cm0, bytes32 cm1, uint256 cvDep0X, uint256 cvDep0Y, uint256 cvDep1X, uint256 cvDep1Y, uint256 rcvTotal, uint256 clueRx0, uint256 clueRy0, uint256 ephPubX0, uint256 ephPubY0, bytes ciphertext0, uint256 clueRx1, uint256 clueRy1, uint256 ephPubX1, uint256 ephPubY1, bytes ciphertext1)",
    "event IntentFlushed(uint256 indexed id, bytes32 cm0, bytes32 cm1)",
] as const;

export const MOCK_QUOTER_V2_ABI = [
    "function set(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint256 gasEstimate)",
] as const;

export const MOCK_SWAP_ROUTER_ABI = [
    "function setNextOut(uint256 v)",
    "function nextOut() view returns (uint256)",
] as const;

// Full SwapArgs calldata layout lives in `swap-harness.ts`.
export const SWAP_WRAPPER_ABI = [
    "function adapterAllowed(address) view returns (bool)",
    "event SwapExecuted(address indexed adapter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 actualOut, uint256 dust, uint256 intentId)",
] as const;
