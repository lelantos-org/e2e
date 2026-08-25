// Minimal ABI fragments, hand-written rather than generated.
//
// Each list carries only what the suite actually calls, so a contract gaining
// a function does not churn this file — but a *changed* signature here fails
// as a decode error at call time, not at build time. `MASP_DEPOSIT_ABI` is
// kept separate from `MASP_ABI` because the direct-deposit path bypasses the
// SDK wallet and needs the raw tuple layout.

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
// A deposit occupies two leaves: the depositor's note (`outCm`, anchored by
// `(cvDep, rcv)`) and a note paying whoever flushes the batch (`feeCm`,
// anchored by `(feeCvDep, feeRcv)`). Both are escrow digest preimage except
// the blinders, and `deposit` therefore takes an aux payload per leaf.
export const MASP_DEPOSIT_ABI = [
    "function deposit((uint256 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32 outCm,uint256[2] cvDep,uint256 rcv,uint64 feeIn,bytes32 feeCm,uint256[2] feeCvDep,uint256 feeRcv) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) aux, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) feeAux) returns (uint256)",
    "function depositAuthorized((uint256 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32 outCm,uint256[2] cvDep,uint256 rcv,uint64 feeIn,bytes32 feeCm,uint256[2] feeCvDep,uint256 feeRcv) d, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) aux, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext) feeAux) returns (uint256)",
    "function cancelDeposit(uint256 id, uint48 publicIn, bytes32 cm, uint256[2] cvDep, uint64 publicAssetId, uint16 fbps, address payer, uint32 submittedAt, uint48 feeIn, bytes32 feeCm, uint256[2] feeCvDep)",
    "function cancelDelay() view returns (uint32)",
    "error SignatureExpired(uint256 signatureDeadline)",
    "error MustHaveDeposit()",
    "event DepositEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, uint16 feeBpsAtSubmit, bytes32 cm, uint256 cvDepX, uint256 cvDepY, uint256 rcv, uint256 clueRx, uint256 clueRy, uint256 ephPubX, uint256 ephPubY, bytes ciphertext, uint64 feeIn, bytes32 feeCm, uint256 feeCvDepX, uint256 feeCvDepY, uint256 feeRcv, uint256 feeClueRx, uint256 feeClueRy, uint256 feeEphPubX, uint256 feeEphPubY, bytes feeCiphertext)",
    "event DepositFlushed(uint256 indexed id, bytes32 cm)",
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
    "event SwapExecuted(address indexed adapter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 actualOut, uint256 dust, uint256 depositId)",
] as const;
