// Test-side controls for the swap stack: resolve the deployed addresses, ask
// the metaquoter for a quote, and drive the mock quoter/router so a swap's
// output is deterministic.
//
// The swap itself is driven through the SDK's `Wallet.swap`. A hand-rolled
// two-leg builder used to live here as well; it was never called by a test and
// no longer compiled against the SDK (`RelayerClient.path` is gone — the
// wallet folds its own tree from the chunk feed now), so it was removed rather
// than left to rot.

import { ethers } from "ethers";

import type { EvmAddress } from "@lelantos-org/sdk";
import { fetchSwapQuote, type SwapQuote, type SwapQuoteRequest } from "@lelantos-org/sdk/quoter";

import { MOCK_QUOTER_V2_ABI, MOCK_SWAP_ROUTER_ABI } from "./constants.js";
import { env } from "./env.js";
import { PROVER_PATHS } from "./harness.js";

export interface SwapHarness {
    metaquoterUrl: string;
    wrapperAddress: EvmAddress;
    adapterAddress: EvmAddress;
    quoterAddress: EvmAddress;
    mockSwapRouterAddress: EvmAddress;
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

export { PROVER_PATHS };
