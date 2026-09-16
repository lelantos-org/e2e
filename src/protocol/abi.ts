// Minimal ABI fragments, hand-written rather than generated.
//
// Each list carries only what the suite calls, so a contract gaining a
// function does not churn this file. A changed signature here fails as a
// decode error at call time, not at build time.

export const MASP_ABI = [
    "function isKnownRoot(bytes32) view returns (bool)",
    // The ring slot `root` sits in: a spend names it as `SpendTree.anchorIndex`.
    "function rootIndexOf(bytes32 root) view returns (bool found, uint256 index)",
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

/**
 * Every event `bundleItems` reads to split a transaction into operations, from
 * the pool and the two adapters that call it.
 *
 * One list rather than three because the walker parses each log by its topic
 * and decides by emitter which contract it came from; see `protocol/logs.ts`.
 */
export const BUNDLE_ITEM_EVENTS_ABI = [
    ...MASP_ABI.filter((f) => f.startsWith("event ")),
    // `NullifierSet`, which the pool inherits.
    "event NullifierConsumed(bytes32 indexed nf)",
    "event NotePayload(bytes32 indexed cm, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint256 cvDepX, uint256 cvDepY)",
    "event AssetMoved(uint64 indexed assetId, address indexed token, uint256 inAmount, uint256 outAmount, uint64 publicIn, uint64 publicOut)",
    // Only its id is read: a swap's output deposit is escrowed in the swap's
    // own operation and flushed by a later one.
    "event DepositEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 cm, uint256 cvDepX, uint256 cvDepY, uint256 rcv, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint64 feeAssetId, uint64 feeIn, bytes32 feeCm, uint256 feeCvDepX, uint256 feeCvDepY, uint256 feeRcv, uint256 feeClueRx, uint256 feeClueRy, uint256 feeEphPubX, uint256 feeEphPubY, bytes feeCiphertext)",
    // `NativeAdapter`, after the pool's withdraw it wraps.
    "event NativeWithdrawn(address indexed recipient, uint256 amount)",
    // `SwapWrapper`, after both of its pool calls: one or the other.
    "event SwapExecuted(address indexed adapter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 actualOut, uint256 dust, uint256 depositId)",
    "event SwapRefunded(address indexed adapter, address indexed tokenIn, uint256 amountIn, uint256 dust, uint256 depositId, bytes4 reason)",
] as const;

/**
 * A relayer's submission contract. Every relayer transaction is an `execute`;
 * its targets are fixed by the factory that created it, so the operator set is
 * all a test configures on a Bundler of its own.
 */
export const BUNDLER_ABI = [
    "function execute((address target, bytes data)[] calls) returns (uint256 executed, bytes reason)",
    "function isOperator(address) view returns (bool)",
    "function POOL() view returns (address)",
    "function NATIVE_ADAPTER() view returns (address)",
    "function SWAP_WRAPPER() view returns (address)",
    "event BundleExecuted(uint256 executed, uint256 total)",
    "event BundleItemFailed(uint256 indexed index, bytes reason)",
    "error NotOperator(address caller)",
    "error CallNotAllowed(uint256 index)",
    "error MalformedCall(uint256 index)",
    "error EmptyBundle()",
] as const;

/**
 * One Bundler per creator, at an address that depends on the creator alone.
 * Every Bundler it creates calls the same pool, native adapter and wrapper.
 */
export const BUNDLER_FACTORY_ABI = [
    "function create(address[] operators) returns (address bundler)",
    "function predict(address owner) view returns (address)",
    "event BundlerCreated(address indexed owner, address indexed bundler)",
] as const;

/**
 * `MASP.transfer`, for building a spend's calldata outside the relayer.
 *
 * The tuple layouts are `MASP.Proof`, `PubInputs.Transact`,
 * `PubInputs.SpendTree` and `AuxValidation.Output`, in declaration order. A
 * spend carries only the tree update's new root, its start index and the ring
 * slot of `pi.merkleRoot`; the pool rebuilds the rest of the proof image.
 */
export const MASP_TRANSFER_ABI = [
    "function transfer((uint256[2] a, uint256[2][2] b, uint256[2] c) p, (bytes32 merkleRoot, bytes32[4] nullifier, bytes32[6] outCm, uint64 publicAssetId, uint64 publicIn, uint64 publicOut, uint256[2][4] inCv, uint256[2][6] outCv, uint256[2][6] outCvDep, address recipient, uint256 chainId, address payer, address relayer, uint256 intentHash) pi, (uint256[2] a, uint256[2][2] b, uint256[2] c) tp, (bytes32 newRoot, uint64 startIndex, uint8 anchorIndex) tpi, (uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext)[6] aux)",
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
    "function deposit((uint256 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32 outCm,uint256[2] cvDep,uint256 rcv,uint64 feeAssetId,uint64 feeIn,bytes32 feeCm,uint256[2] feeCvDep,uint256 feeRcv) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,uint256 maxFee,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) aux, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) feeAux) returns (uint256)",
    "error SignatureExpired(uint256 signatureDeadline)",
    "event DepositEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 cm, uint256 cvDepX, uint256 cvDepY, uint256 rcv, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint64 feeAssetId, uint64 feeIn, bytes32 feeCm, uint256 feeCvDepX, uint256 feeCvDepY, uint256 feeRcv, uint256 feeClueRx, uint256 feeClueRy, uint256 feeEphPubX, uint256 feeEphPubY, bytes feeCiphertext)",
    "event DepositFlushed(uint256 indexed id, bytes32 cm)",
    // The payer's way out of a deposit no relayer will flush. Every argument is
    // the digest preimage the pool dropped from storage at submit, so a caller
    // resupplies it from the deposit's own `DepositEscrowed` event.
    // A relayer note paid in another asset is refunded in that asset, so a
    // cancel reports two amounts: `refunded` in the deposit's token and
    // `feeRefunded` in `feeAssetId`'s, nonzero only on the two-token path.
    "function cancelDeposit(uint256 id, uint48 publicIn, bytes32 cm, uint256[2] cvDep, uint64 publicAssetId, uint16 fbps, address payer, uint32 submittedAt, (uint48 feeIn, uint64 feeAssetId, bytes32 feeCm, uint256[2] feeCvDep) feeNote) returns (uint256 total, uint256 feeRefunded)",
    "event DepositCanceled(uint256 indexed id, address indexed payer, uint256 refunded, uint64 feeAssetId, uint256 feeRefunded)",
    "error FeeAssetMustBeZero()",
    "error FeeAssetUnsupported(uint64 id)",
    "error BadMaxFee()",
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
    "event SwapRefunded(address indexed adapter, address indexed tokenIn, uint256 amountIn, uint256 dust, uint256 depositId, bytes4 reason)",
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
