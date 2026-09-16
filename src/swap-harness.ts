// Test-side controls for the swap stack: resolve the deployed addresses and
// drive the mock quoter/router so a swap's output is deterministic. The swap
// itself is priced and run through the SDK wallet (`quoteSwap`, then `swap`),
// which reaches the metaquoter and the wrapper through the network preset
// `src/wallet.ts` builds.

import { ethers } from "ethers";
import { expect } from "vitest";

import type { EvmAddress, SwapQuote, WalletApi } from "@lelantos-org/sdk";

import { MASP_DEPOSIT_ABI, MOCK_ERC20_ABI, MOCK_QUOTER_V2_ABI, MOCK_SWAP_ROUTER_ABI } from "./protocol/abi.js";
import { amt, baseAmt, circuitFee, depositTotal, feeFor } from "./protocol/amounts.js";
import { ASSET, ASSETS } from "./protocol/assets.js";
import { parseContractLogs } from "./protocol/logs.js";
import { env } from "./env.js";
import { tokenAddressFor } from "./harness.js";

/** The pair every swap in the suite trades: mDAI in, mWBTC out. */
export const SWAP_ASSET_IN = ASSET;
export const SWAP_ASSET_OUT = ASSETS.MWBTC;

/** The univ3 pool fee tier the mock quoter is seeded under. */
export const FEE_TIER = 500;

/**
 * What a test swap sells, and what reaches the venue.
 *
 *   `SWAP_PUBLIC_OUT` — the swap's `gross`: 100 units plus their circuit-unit
 *     fee, so the pool sees publicOut = 105. Named as `gross` rather than as
 *     `net: 100`, which the SDK would round up to the smallest publicOut whose
 *     net covers 100 whole units (106), not the 105 the figures below pin.
 *   `WRAPPER_AMOUNT_IN` — `MASP.withdraw` then skims `feeBps` off that before
 *     paying the wrapper, so the adapter receives less again. It is the
 *     quote's `net`.
 *
 * The swap path applies the same rule as `full-flow`'s withdraw.
 */
export const SWAP_UNITS = 100n;
export const SWAP_PUBLIC_OUT = SWAP_UNITS + circuitFee(SWAP_UNITS);
export const WRAPPER_AMOUNT_IN = baseAmt(SWAP_PUBLIC_OUT) - feeFor(SWAP_PUBLIC_OUT);

/**
 * What the mock router is told to deliver, making the output escrow
 * deterministic and assertable exactly rather than as "> 0".
 */
export const ROUTER_OUT = 100n;

/** Output-token liquidity minted to the mock router, well above any one fill. */
const ROUTER_LIQUIDITY = 10_000n;

export interface SwapHarness {
    wrapperAddress: EvmAddress;
    adapterAddress: EvmAddress;
    quoterAddress: EvmAddress;
    mockSwapRouterAddress: EvmAddress;
}

export function setupSwapHarness(): SwapHarness {
    return {
        wrapperAddress: env.swap.wrapper(),
        adapterAddress: env.swap.univ3Adapter(),
        quoterAddress: env.swap.univ3Quoter(),
        mockSwapRouterAddress: env.swap.mockSwapRouter(),
    };
}

/**
 * The venue every test swap runs against: the deployed addresses, output
 * liquidity on the mock router, and a quote seeded for the pair.
 *
 * The quoter returns a fixed `ROUTER_OUT` for the pair whatever `amountIn` it
 * is asked about, so the quote does not depend on the swap's size. What the
 * router actually fills is set per swap with `setMockNextOut`.
 */
export async function setupSwapVenue(payer: ethers.Signer): Promise<SwapHarness> {
    const s = setupSwapHarness();
    const out = new ethers.Contract(tokenAddressFor(SWAP_ASSET_OUT).address, MOCK_ERC20_ABI, payer);
    await (await out.mint(s.mockSwapRouterAddress, ROUTER_LIQUIDITY)).wait();
    await setMockQuote(payer, s, {
        tokenIn: tokenAddressFor(SWAP_ASSET_IN).address,
        tokenOut: tokenAddressFor(SWAP_ASSET_OUT).address,
        fee: FEE_TIER,
        amountOut: ROUTER_OUT,
        gasEstimate: 80_000n,
    });
    return s;
}

/**
 * `w`'s quote for the suite's swap: `SWAP_PUBLIC_OUT` of the input asset,
 * named as `gross`. The wallet asks the quoter about the amount that will
 * actually be swapped, the quote's `net`.
 */
export function quoteTestSwap(w: WalletApi): Promise<SwapQuote> {
    return w.quoteSwap({
        assetIn: SWAP_ASSET_IN,
        assetOut: SWAP_ASSET_OUT,
        gross: amt(SWAP_PUBLIC_OUT),
        slippageBps: 50,
    });
}

/**
 * Assert that `credited` is exactly the note a swap escrowed: the output note
 * behind a `SwapExecuted`, or the refund note behind a `SwapRefunded`.
 *
 * The note's size is the SDK's to choose, so rather than restating that rule
 * the credit is tied back to the chain. The wrapper holds `available` — the
 * adapter's `actualOut`, or for a refund what leg 1 delivered — and pulls
 * `depositTotal(publicIn, feeIn)` of it into the pool for the escrowed request
 * (principal, the pool's shield fee, and the note paying the flush), sending
 * the rest to the treasury as the event's `dust`. The request is read off the
 * escrow's own `DepositEscrowed` log.
 *
 * Returns the wrapper's pull, for bounds a caller asserts on top.
 */
export async function expectSwapEscrowCredited(
    provider: ethers.Provider,
    args: {
        txHash: string;
        /** The wrapper's `SwapExecuted` or `SwapRefunded`. */
        event: ethers.Result;
        /** What the wrapper held for the escrow: `actualOut`, or a refund's `amountIn`. */
        available: bigint;
        /** The escrowed note's asset. */
        asset: bigint;
        credited: bigint;
    },
): Promise<bigint> {
    const depositId = args.event.depositId as bigint;
    const receipt = await provider.getTransactionReceipt(args.txHash);
    const reader = new ethers.Contract(env.maspAddress, MASP_DEPOSIT_ABI, provider);
    const escrow = parseContractLogs(receipt, reader, "DepositEscrowed").find((l) => l.args.id === depositId);
    if (escrow === undefined) throw new Error(`${args.txHash}: no DepositEscrowed for deposit ${depositId}`);
    const publicIn = escrow.args.publicIn as bigint;
    const feeIn = escrow.args.feeIn as bigint;

    expect(args.credited, "the credited note is the one the wrapper escrowed").toBe(publicIn);
    const pulled = depositTotal(publicIn, feeIn, args.asset);
    expect(pulled + (args.event.dust as bigint), "the pull and the dust account for what the wrapper held")
        .toBe(args.available);
    return pulled;
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
