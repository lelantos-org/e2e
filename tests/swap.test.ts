import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    amt,
    ASSET,
    ASSETS,
    awaitBalance,
    awaitOwn,
    baseAmt,
    circuitFee,
    DEAD_ADDRESS,
    type Erc20Helpers,
    expectRevert,
    feeFor,
    type Harness,
    MOCK_ERC20_ABI,
    parseContractLogs,
    REVERT,
    SWAP_WRAPPER_ABI,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import {
    quoteSwap,
    setMockNextOut,
    setMockQuote,
    setupSwapHarness,
    type SwapHarness,
} from "../src/swap-harness.js";

const ASSET_OUT = ASSETS.MWBTC;
const FEE_TIER = 500;

/// What Alice asks to swap, and the two grossed-up figures that follow from it.
///
///   `SWAP_PUBLIC_OUT` — the SDK sizes the withdraw leg to cover the amount
///     *plus* its circuit-unit fee, so the pool sees publicOut = 105, not 100.
///   `WRAPPER_AMOUNT_IN` — MASP.withdraw then skims `feeBps` off that before
///     paying the wrapper, so the adapter is handed less again.
///
/// Both rules already appear in `full-flow`'s withdraw assertions; the swap
/// path simply applies them one after the other.
const SWAP_UNITS = 100n;
const SWAP_PUBLIC_OUT = SWAP_UNITS + circuitFee(SWAP_UNITS);
const WRAPPER_AMOUNT_IN = baseAmt(SWAP_PUBLIC_OUT) - feeFor(SWAP_PUBLIC_OUT);

/// What the mock router is told to deliver, so the leg-2 escrow is
/// deterministic and can be asserted exactly rather than as "> 0".
const ROUTER_OUT = 100n;

// The swap stack is deployed only when E2E_SKIP_SWAP is unset. Skip rather
// than blow up in `beforeAll`: a partial stack should report "not exercised".
describe.skipIf(!process.env.SWAP_WRAPPER_ADDRESS)("masp swap e2e", () => {
    let h: Harness;
    let s: SwapHarness;
    let alice: SdkWallet;
    let mDai: Erc20Helpers;
    let wrapper: ethers.Contract;

    beforeAll(async () => {
        // Three swaps' worth: the happy path plus two negatives, each of which
        // funds its own note.
        const f = await setupFile({
            nsks: TEST_NSK.swap,
            fund: [{ asset: ASSET, amount: withFee(1_000n) }],
        });
        ({ h } = f);
        ({ alice } = f.w);
        mDai = f.token(ASSET);

        s = setupSwapHarness();
        wrapper = new ethers.Contract(s.wrapperAddress, SWAP_WRAPPER_ABI, h.provider);

        // Fund the mock router with mWBTC; the adapter needs output liquidity.
        const mWbtc = new ethers.Contract(env.token3, MOCK_ERC20_ABI, h.payer);
        await (await mWbtc.mint(s.mockSwapRouterAddress, 10_000n)).wait();

        await setMockQuote(h.payer, s, {
            tokenIn: env.token2,
            tokenOut: env.token3,
            fee: FEE_TIER,
            amountOut: ROUTER_OUT,
            gasEstimate: 80_000n,
        });
    });

    /// A note big enough for one swap.
    const fundOneSwap = () =>
        alice.deposit({ amount: amt(SWAP_PUBLIC_OUT), asset: ASSET })
            .then((r) => awaitOwn(alice, r));

    /// The quoter is seeded with a fixed `amountOut` for the pair, so the quote
    /// does not depend on `amountIn` — but ask for what will actually be
    /// swapped anyway, so the request is not quietly lying about the trade.
    const quoteForSwap = () =>
        quoteSwap(s, {
            // The metaquoter's request shape takes a JS number, unlike the
            // circuit/PI paths which are all bigint.
            chainId: Number(env.chainId),
            tokenIn: env.token2,
            tokenOut: env.token3,
            amountIn: WRAPPER_AMOUNT_IN,
            slippageBps: 50,
        });

    const doSwap = (quote: Awaited<ReturnType<typeof quoteForSwap>>) =>
        alice.swap({
            assetIn: ASSET,
            assetOut: ASSET_OUT,
            amount: amt(SWAP_UNITS),
            quote,
            wrapperAddress: s.wrapperAddress,
        });

    /// Run the swap and wait for both legs: the leg-1 change notes come back on
    /// the result, but the leg-2 B note (assetOut) is escrowed by the wrapper
    /// and materialises asynchronously through the relayer's flushBatch, so it
    /// is only visible via a balance poll.
    const swapped = once(async () => {
        await fundOneSwap();
        const quote = await quoteForSwap();
        await setMockNextOut(h.payer, s, ROUTER_OUT);

        const r = await doSwap(quote);
        await awaitOwn(alice, r);
        const outBalance = await awaitBalance(alice, ASSET_OUT);

        const receipt = await h.provider.getTransactionReceipt(r.txHash);
        return { quote, outBalance, events: parseContractLogs(receipt, wrapper, "SwapExecuted") };
    });

    it("quote resolves to the allowlisted univ3 adapter", async () => {
        const quote = await quoteForSwap();
        expect(quote.venue).toBe("univ3");
        expect(quote.adapter.toLowerCase()).toBe(s.adapterAddress.toLowerCase());
        expect(await wrapper.adapterAllowed(quote.adapter), "adapter is allowlisted").toBe(true);
    }, TEST_TIMEOUT.SWAP);

    it("happy path: deposit asset 2 -> swap -> fresh asset 3 note", async () => {
        const { quote, outBalance, events } = await swapped();

        expect(events, "exactly one SwapExecuted").toHaveLength(1);
        const e = events[0].args;
        expect((e.adapter as string).toLowerCase()).toBe(s.adapterAddress.toLowerCase());
        expect((e.tokenIn as string).toLowerCase()).toBe(env.token2.toLowerCase());
        expect((e.tokenOut as string).toLowerCase()).toBe(env.token3.toLowerCase());
        expect(e.amountIn, "wrapper receives publicOut net of the MASP fee").toBe(WRAPPER_AMOUNT_IN);
        expect(e.actualOut, "adapter delivered what the mock was seeded with").toBe(ROUTER_OUT);

        // The B note is sized by the SDK from `quote.minOut`. Rather than
        // duplicating that rule here, tie the credited balance back to what the
        // chain says was escrowed: everything the adapter produced is either
        // pulled into the pool (principal + fee for the new note) or left as
        // dust, and the note credited to Alice must account for the pulled part
        // exactly.
        const pulled = (e.actualOut as bigint) - (e.dust as bigint);
        expect(withFee(outBalance, ASSET_OUT), "credited note accounts for the pulled amount")
            .toBe(pulled);
        // The wrapper's own two guards, restated against the observed numbers:
        // it may not pull more than the adapter produced, nor settle for less
        // than the quote's floor.
        expect(pulled).toBeLessThanOrEqual(e.actualOut as bigint);
        expect(pulled).toBeGreaterThanOrEqual(quote.minOut);
        expect(outBalance, "a real B note, not an empty credit").toBeGreaterThan(0n);
    }, TEST_TIMEOUT.SWAP);

    /// A refused swap has to be both *explained* and *inert*.
    ///
    /// The reason matters because a caller cannot fix a payload they are not
    /// told is wrong: the relayer's `eth_call` pre-flight catches these before
    /// anything is broadcast and reports them as `ContractRejected` (HTTP 400)
    /// carrying the contract's own revert data.
    ///
    /// The effects matter because a rejection that still moved funds would be
    /// far worse than one with a vague message.
    async function expectSwapRefused(
        run: () => Promise<unknown>,
        reason: RegExp,
    ): Promise<void> {
        const outBefore = alice.balance(ASSET_OUT);
        const maspBefore = await mDai.balanceOf(env.maspAddress);

        await expectRevert(run(), reason);

        expect(alice.balance(ASSET_OUT), "no assetOut credited").toBe(outBefore);
        expect(await mDai.balanceOf(env.maspAddress), "no assetIn left the pool")
            .toBe(maspBefore);
    }

    it("refuses a swap through a non-allowlisted adapter", async () => {
        await fundOneSwap();
        const quote = await quoteForSwap();
        await setMockNextOut(h.payer, s, ROUTER_OUT);

        await expectSwapRefused(
            () => doSwap({ ...quote, adapter: DEAD_ADDRESS as `0x${string}` }),
            REVERT.ADAPTER_NOT_ALLOWED,
        );
    }, TEST_TIMEOUT.SWAP);

    it("refuses a swap when the adapter under-delivers vs minOut", async () => {
        await fundOneSwap();
        const quote = await quoteForSwap();
        // One unit out against a ~99-unit minOut.
        await setMockNextOut(h.payer, s, 1n);

        await expectSwapRefused(() => doSwap(quote), REVERT.SWAP_UNDER_MIN_OUT);
    }, TEST_TIMEOUT.SWAP);
});
