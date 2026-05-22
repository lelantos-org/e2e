// Shielded note A -> SwapWrapper -> shielded note B. Leg-1 transact_2x2 binds
// recipient = wrapperAddress; leg-2 deposit intent binds payer = wrapperAddress.
// The B note materialises asynchronously through the relayer's flushBatch worker.

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
} from "./constants.js";
import { env } from "./env.js";
import {
    type Harness,
    PROVER_PATHS,
} from "./harness.js";
import { inputSlotFor, rngForOutput, type TestWallet, waitForCm } from "./scenario.js";

export interface SwapHarness {
    metaquoterUrl: string;
    wrapperAddress: string;
    adapterAddress: string;
    quoterAddress: string;
    mockSwapRouterAddress: string;
}

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

export async function setMockQuote(
    payer: ethers.Signer,
    s: SwapHarness,
    args: { tokenIn: string; tokenOut: string; fee: number; amountOut: bigint; gasEstimate: bigint },
): Promise<void> {
    const c = new ethers.Contract(s.quoterAddress, MOCK_QUOTER_V2_ABI, payer);
    await (await c.set(args.tokenIn, args.tokenOut, args.fee, args.amountOut, args.gasEstimate)).wait();
}

export async function setMockNextOut(
    payer: ethers.Signer,
    s: SwapHarness,
    nextOut: bigint,
): Promise<void> {
    const c = new ethers.Contract(s.mockSwapRouterAddress, MOCK_SWAP_ROUTER_ABI, payer);
    await (await c.setNextOut(nextOut)).wait();
}

export interface SwapOpts {
    h: Harness;
    s: SwapHarness;
    input: SpendableCachedNote;
    assetIn?: bigint;
    recipient: TestWallet;
    assetOut: bigint;
    // Two change notes summing to `input.value - publicOut`.
    change: [Note, Note];
    changeRecipient: TestWallet;
    // publicOut-units; wrapper receives `publicOut * scaleFor(assetIn)`.
    publicOut: bigint;
    quote: SwapQuote;
    // value = quote.minOut / scaleFor(assetOut).
    bNote: Note;
    auxRng: () => Field;
    // Negative tests use this to bypass the allowlisted adapter.
    adapterOverride?: string;
}

// Caller awaits the B note separately via `waitForCm(h.fmd, bNote.cm)`.
export async function executeSwap(
    opts: SwapOpts,
): Promise<{ payload: SubmitSwapPayload; txHash: string; legBundle: Awaited<ReturnType<typeof buildWithdraw>>; intentBundle: ReturnType<typeof buildDeposit> }> {
    const { h, s, input, recipient, change, changeRecipient, publicOut, quote, bNote, auxRng } = opts;
    const assetIn = opts.assetIn ?? ASSET;
    const wrapperAddress = s.wrapperAddress;

    // Wrapper is the on-chain recipient + msg.sender, so transact_2x2 PI must
    // bind both `recipient` and `relayer` to wrapperAddress.
    const slot0 = await inputSlotFor(h.P, h.fmd, input);
    const withdrawBundle = await buildWithdraw({
        ...h.bundleCommon(assetIn),
        recipientAddress: wrapperAddress,
        relayerAddress: wrapperAddress,
        inputs: [slot0, null],
        merkleRoot: await h.currentRoot(),
        publicOut,
        change,
        changeRecipients: [changeRecipient.recipient, changeRecipient.recipient],
        changeRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
    });

    // submitIntentAuthorized requires msg.sender == intent.payer.
    const intentBundle = buildDeposit({
        P: h.P,
        J: h.J,
        chainId: h.bundleCommon(opts.assetOut).chainId,
        asset: opts.assetOut,
        payerAddress: wrapperAddress,
        recipientAddress: env.recipientAddress,
        publicIn: bNote.value,
        recipient: recipient.recipient,
        output0: { rho: bNote.rho, rcm: bNote.rcm, rcv: bNote.rcv, rcvDep: bNote.rcvDep, aux: rngForOutput(auxRng) },
        output1Pad: { rho: auxRng(), rcm: auxRng(), rcv: auxRng(), rcvDep: auxRng() },
    });

    // MASP.withdraw skims feeBps before transferring to recipient (= wrapper).
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
            tokenIn: env.token2, // overwritten below from assetIn
            tokenOut: tokenAddrForAsset(opts.assetOut),
            amountIn: amountInUnits,
            minOut: quote.minOut,
        },
    };
    payload.swap.tokenIn = tokenAddrForAsset(assetIn);

    const { txHash } = await h.relayer.submitSwap(payload);

    // Leg-1 change notes only; B note arrives later via flushBatch.
    await waitForCm(h.fmd, withdrawBundle.cm[0]);
    await waitForCm(h.fmd, withdrawBundle.cm[1]);

    return { payload, txHash, legBundle: withdrawBundle, intentBundle };
}

// AuxOutput (flat scalars + bytes) → TransactAux (point-as-{x,y}).
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

function tokenAddrForAsset(asset: bigint): string {
    const id = Number(asset);
    const v = process.env[`TOKEN_${id}`];
    if (!v) throw new Error(`tokenAddrForAsset: TOKEN_${id} not set`);
    return v;
}

export { PROVER_PATHS };
