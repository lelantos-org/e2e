// Swap-side recipes: shielded note A -> SwapWrapper -> shielded note B.
//
// Layered on top of the existing `Harness` so legacy deposit/transfer/
// withdraw tests are untouched. Builds the leg-1 transact_2x2 SNARK with
// `recipient = wrapperAddress` and the leg-2 deposit intent with
// `payer = wrapperAddress`, fetches a quote from metaquoter, then POSTs
// `/v1/swap` to the relayer. The B note materialises later through the
// relayer's existing `flushBatch` worker.

import { ethers } from "ethers";

import {
    buildDeposit,
    buildWithdraw,
    fetchSwapQuote,
    type Field,
    type Note,
    type SpendableCachedNote,
    type SubmitSwapPayload,
    type SwapQuote,
    type SwapQuoteRequest,
} from "@lelantos-org/sdk";

import {
    ASSET,
    baseAmt,
    feeFor,
    MOCK_QUOTER_V2_ABI,
    MOCK_SWAP_ROUTER_ABI,
} from "./constants";
import { env } from "./env";
import {
    type Harness,
    PROVER_PATHS,
} from "./harness";
import { inputSlotFor, rngForOutput, type TestWallet, waitForCm } from "./scenario";

export interface SwapHarness {
    metaquoterUrl: string;
    wrapperAddress: string;
    adapterAddress: string;
    quoterAddress: string;
    mockSwapRouterAddress: string;
}

/// Read swap addresses + metaquoter URL from the published env vars and
/// return them in one struct. Tests pass the result around explicitly so
/// that swap-only tests can fail loudly when the runner forgot to deploy
/// the swap stack.
export function setupSwapHarness(): SwapHarness {
    return {
        metaquoterUrl: env.metaquoterUrl(),
        wrapperAddress: env.swap.wrapper(),
        adapterAddress: env.swap.univ3Adapter(),
        quoterAddress: env.swap.univ3Quoter(),
        mockSwapRouterAddress: env.swap.mockSwapRouter(),
    };
}

export async function quoteSwap(
    s: SwapHarness,
    req: SwapQuoteRequest,
): Promise<SwapQuote> {
    return fetchSwapQuote(s.metaquoterUrl, req);
}

// ──────────────────────────────────────────────────────────────────────
// Mock swap-stack control (test-only)
// ──────────────────────────────────────────────────────────────────────

/// Pre-set the MockQuoterV2 quote for a `(tokenIn, tokenOut, fee)` triple.
/// Tests use this to drive metaquoter responses without changing on-chain
/// pool liquidity.
export async function setMockQuote(
    payer: ethers.NonceManager,
    s: SwapHarness,
    args: { tokenIn: string; tokenOut: string; fee: number; amountOut: bigint; gasEstimate: bigint },
): Promise<void> {
    const c = new ethers.Contract(s.quoterAddress, MOCK_QUOTER_V2_ABI, payer);
    await (await c.set(args.tokenIn, args.tokenOut, args.fee, args.amountOut, args.gasEstimate)).wait();
}

/// Set the `nextOut` value the MockSwapRouter02 will deliver on the next
/// `exactInputSingle` / `exactInput` call. Tests use this to drive
/// slippage scenarios.
export async function setMockNextOut(
    payer: ethers.NonceManager,
    s: SwapHarness,
    nextOut: bigint,
): Promise<void> {
    const c = new ethers.Contract(s.mockSwapRouterAddress, MOCK_SWAP_ROUTER_ABI, payer);
    await (await c.setNextOut(nextOut)).wait();
}

// ──────────────────────────────────────────────────────────────────────
// High-level recipe
// ──────────────────────────────────────────────────────────────────────

export interface SwapOpts {
    h: Harness;
    s: SwapHarness;
    /// Spendable A-side note(s); single-input today, two-input merge is a
    /// follow-up.
    input: SpendableCachedNote;
    /// Asset id of `input` (token A side).
    assetIn?: bigint;
    /// Destination shielded wallet (where the B note lands).
    recipient: TestWallet;
    /// Asset id of the B-side note.
    assetOut: bigint;
    /// Two change notes back to the sender, summing to `input.value -
    /// publicOut`. For 1-input swap of full balance, both are zero-value.
    change: [Note, Note];
    changeRecipient: TestWallet;
    /// Public payload of the leg-1 withdraw, in publicOut-units. Wrapper
    /// will receive `publicOut * scaleFor(assetIn)` of the underlying ERC20.
    publicOut: bigint;
    /// Output of the metaquoter quote driving this swap.
    quote: SwapQuote;
    /// B-note payload (fresh shielded output post-swap). value = quote.minOut /
    /// scaleFor(assetOut).
    bNote: Note;
    /// Deterministic randomness (mirrors deposit/withdraw recipes).
    auxRng: () => Field;
    /// Override target adapter (used by negative tests). Defaults to the
    /// allowlisted adapter from the swap harness.
    adapterOverride?: string;
}

/// Build leg-1 withdraw + leg-2 escrow intent + submit `/v1/swap`. Waits
/// for fmd-webserver to index the leg-1 change notes; the B note is
/// materialised asynchronously by `FlushPipeline` and is awaited
/// separately by callers via `waitForCm(h.fmd, bNote.cm)`.
export async function executeSwap(
    opts: SwapOpts,
): Promise<{ payload: SubmitSwapPayload; txHash: string; legBundle: Awaited<ReturnType<typeof buildWithdraw>>; intentBundle: ReturnType<typeof buildDeposit> }> {
    const { h, s, input, recipient, change, changeRecipient, publicOut, quote, bNote, auxRng } = opts;
    const assetIn = opts.assetIn ?? ASSET;
    const wrapperAddress = s.wrapperAddress;

    // Leg 1: build the same withdraw bundle a normal `submitWithdraw`
    // would, but the on-chain recipient is the SwapWrapper rather than a
    // user EOA. The transact_2x2 PI binds `recipient = wrapper`, so the
    // wrapper is the only contract that can accept the unshielded ERC20.
    const slot0 = await inputSlotFor(h.P, h.fmd, input);
    const withdrawBundle = await buildWithdraw({
        ...h.bundleCommon(assetIn),
        // Override `recipientAddress` so PIs encode the wrapper, not the
        // legacy test recipient. The wrapper receives the unshielded
        // ERC20 from MASP.withdraw.
        recipientAddress: wrapperAddress,
        // MASP enforces `pi.relayer == msg.sender` on withdraw. The
        // wrapper is `msg.sender` to MASP, so the proof must bind
        // `relayer = wrapperAddress` (not the relayer's signer key).
        relayerAddress: wrapperAddress,
        inputs: [slot0, null],
        merkleRoot: await h.currentRoot(),
        publicOut,
        change,
        changeRecipients: [changeRecipient.recipient, changeRecipient.recipient],
        changeRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
    });

    // Leg 2: build the slim deposit intent for the B note. `payer` is the
    // wrapper because `submitIntentAuthorized` requires msg.sender ==
    // intent.payer, and the wrapper is the on-chain caller.
    const intentBundle = buildDeposit({
        P: h.P,
        J: h.J,
        chainId: h.bundleCommon(opts.assetOut).chainId,
        asset: opts.assetOut,
        payerAddress: wrapperAddress,
        recipientAddress: env.recipientAddress,
        publicIn: bNote.value,
        recipient: recipient.recipient,
        output0: { rho: bNote.rho, rcm: bNote.rcm, rcv: bNote.rcv, aux: rngForOutput(auxRng) },
        output1Pad: { rho: auxRng(), rcm: auxRng(), rcv: auxRng() },
    });

    // MASP.withdraw skims `feeBps` off the gross before transferring to
    // `recipient` (= the wrapper). So the wrapper actually holds
    // `publicOut * scale - fee`, and that is what we feed the adapter.
    const amountInUnits = baseAmt(publicOut, assetIn) - feeFor(publicOut, assetIn);

    const payload: SubmitSwapPayload = {
        chainId: h.bundleCommon().chainId,
        proof2x2: withdrawBundle.payload.proof2x2,
        pubInputs: withdrawBundle.payload.pubInputs,
        aux: withdrawBundle.payload.aux,
        swap: {
            adapter: opts.adapterOverride ?? s.adapterAddress,
            route: quote.route,
            intentD: intentBundle.intent,
            auxD: intentBundle.aux.map(auxOutputToTransactAux) as [
                SubmitSwapPayload["aux"][0],
                SubmitSwapPayload["aux"][1],
            ],
            tokenIn: env.token2,        // see SwapOpts: caller controls assetIn -> token resolution
            tokenOut: tokenAddrForAsset(opts.assetOut),
            amountIn: amountInUnits,
            minOut: quote.minOut,
        },
    };
    // Resolve tokenIn from assetIn (above default uses `env.token2` which is
    // the only registered ERC20 with public `mint`; multi-asset tests
    // override).
    payload.swap.tokenIn = tokenAddrForAsset(assetIn);

    const { txHash } = await h.relayer.submitSwap(payload);

    // Wait for leg-1 change notes to land in fmd. B note is asynchronous
    // (flushBatch worker) and the caller decides when to await it.
    await waitForCm(h.fmd, withdrawBundle.cm[0]);
    await waitForCm(h.fmd, withdrawBundle.cm[1]);

    return { payload, txHash, legBundle: withdrawBundle, intentBundle };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/// `buildDeposit` returns aux in `AuxOutput` shape (flat scalars + bytes);
/// the relayer wire format (and SwapBlob.auxD) uses `TransactAux` shape
/// (point-as-{x,y}). Convert here.
function auxOutputToTransactAux(a: {
    clueRx: bigint;
    clueRy: bigint;
    ephPubX: bigint;
    ephPubY: bigint;
    ciphertext: Uint8Array;
}): SubmitSwapPayload["aux"][0] {
    return {
        clueR: [a.clueRx, a.clueRy],
        ephPub: [a.ephPubX, a.ephPubY],
        ciphertext: a.ciphertext,
    };
}

/// Map asset id -> ERC20 address from the deploy-time env. Mirrors the
/// asset-registry fixture used by `DeployTest.s.sol`.
function tokenAddrForAsset(asset: bigint): string {
    const id = Number(asset);
    const v = process.env[`TOKEN_${id}`];
    if (!v) throw new Error(`tokenAddrForAsset: TOKEN_${id} not set`);
    return v;
}

/// Re-export so swap.test.ts has every helper at one import path.
export { PROVER_PATHS };
