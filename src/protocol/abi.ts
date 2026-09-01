// Minimal ABI fragments, hand-written rather than generated.
//
// Each list carries only what the suite calls, so a contract gaining a
// function does not churn this file. A changed signature here fails as a
// decode error at call time, not at build time.

export const MASP_ABI = [
    "function isKnownRoot(bytes32) view returns (bool)",
    "function committedCount() view returns (uint64)",
    // Per asset and per leg since contracts 0.5.0; there is no pool-wide rate.
    "function assetFees(uint64 id) view returns (uint16 depositBps, uint16 withdrawBps)",
    "function treasury() view returns (address)",
    "function accruedFee(address) view returns (uint256)",
    // Per-deposit escrow digest; nonzero exactly while the deposit is still
    // pending, so a deposit no relayer will flush is observable from the chain.
    "function escrowed(uint256 id) view returns (bytes32)",
    // Blocks a deposit must age before `cancelDeposit` accepts it.
    "function cancelDelay() view returns (uint32)",
    "event DepositFlushed(uint256 indexed id, bytes32 cm)",
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

/**
 * Raw deposit entry point, kept separate from `MASP_ABI` because
 * `submitDepositDirect` bypasses the SDK wallet and needs the tuple layout.
 *
 * A deposit occupies two leaves: the depositor's note (`outCm`, anchored by
 * `(cvDep, rcv)`) and a note paying whoever flushes the batch (`feeCm`,
 * anchored by `(feeCvDep, feeRcv)`). Both are part of the escrow digest
 * preimage except for the blinders, so `deposit` takes one aux payload per
 * leaf.
 */
export const MASP_DEPOSIT_ABI = [
    "function deposit((uint256 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32 outCm,uint256[2] cvDep,uint256 rcv,uint64 feeIn,bytes32 feeCm,uint256[2] feeCvDep,uint256 feeRcv) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) aux, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) feeAux) returns (uint256)",
    "error SignatureExpired(uint256 signatureDeadline)",
    "event DepositEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 cm, uint256 cvDepX, uint256 cvDepY, uint256 rcv, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint64 feeIn, bytes32 feeCm, uint256 feeCvDepX, uint256 feeCvDepY, uint256 feeRcv, uint256 feeClueRx, uint256 feeClueRy, uint256 feeEphPubX, uint256 feeEphPubY, bytes feeCiphertext)",
    "event DepositFlushed(uint256 indexed id, bytes32 cm)",
    // The payer's way out of a deposit no relayer will flush. Every argument is
    // the digest preimage the pool dropped from storage at submit, so a caller
    // resupplies it from the deposit's own `DepositEscrowed` event.
    "function cancelDeposit(uint256 id, uint48 publicIn, bytes32 cm, uint256[2] cvDep, uint64 publicAssetId, uint16 fbps, address payer, uint32 submittedAt, (uint48 feeIn, bytes32 feeCm, uint256[2] feeCvDep) feeNote)",
    "event DepositCanceled(uint256 indexed id, address indexed payer, uint256 amount)",
] as const;

export const MOCK_QUOTER_V2_ABI = [
    "function set(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint256 gasEstimate)",
] as const;

export const MOCK_SWAP_ROUTER_ABI = [
    "function setNextOut(uint256 v)",
] as const;

export const SWAP_WRAPPER_ABI = [
    "function adapterAllowed(address) view returns (bool)",
    "event SwapExecuted(address indexed adapter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 actualOut, uint256 dust, uint256 depositId)",
] as const;

/**
 * The local yield vault, as the suite drives it.
 *
 * Only the mutators: the vault starts empty at a 1:1 share price and nothing in
 * the deploy seeds it, so `earn` and `lose` are the only way a test moves the
 * index off `RAY`. What the move did is read back off the pool, through
 * {@link MASP_YIELD_ABI}, rather than off the vault's own share price.
 */
export const MOCK_ERC4626_ABI = [
    // Credits the vault with `amt` more underlying than was deposited, without
    // minting shares: the index moves, every holder's units are worth more.
    "function earn(uint256 amt)",
    "function lose(uint256 amt)",
    // Caps what `withdraw` will pay out, for exercising the pool's idle-buffer
    // refill path against a venue that cannot return everything at once.
    "function setLiquidityCap(uint256 cap)",
] as const;

/** The pool's per-asset yield state, and what the venue holds against it. */
export const MASP_YIELD_ABI = [
    // Derived, RAY-scaled, and floored — a display figure. Size a payment off
    // the `yieldState` gross/supply pair instead; see the SDK's
    // `toTokenUnitsAtRate`.
    "function index(uint64 id) view returns (uint256)",
    "function yieldState(uint64 id) view returns ((address venue, uint16 bufferBps, uint16 perfBps, bool halted, uint256 totalNormalized, uint256 accruedFeeNormalized, uint256 idle, uint256 lastIdx, uint256 index))",
] as const;

/**
 * The pool's permissionless yield maintenance, as the suite drives it.
 *
 * Mutators, so they need a signer; kept out of {@link MASP_YIELD_ABI}, which
 * every read reaches through a bare provider.
 *
 * `NormalizedFeeSwept` is the only place a sweep's two halves are observable
 * together: `sweepNormalized` clears the accumulator, so the units it converted
 * cannot be read back off `yieldState` afterwards, and its return value is
 * unreachable from a transaction.
 */
export const MASP_YIELD_MAINT_ABI = [
    "function accruePerf(uint64 id)",
    "function sweepNormalized(uint64 id) returns (uint256)",
    "event NormalizedFeeSwept(uint64 indexed assetId, uint256 units, uint256 amount)",
] as const;

/** The venue leg of the pool's gross: what it currently holds at the vault. */
export const YIELD_VENUE_ABI = [
    "function totalAssets() view returns (uint256)",
] as const;
