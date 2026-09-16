import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { evmAddress, type SwapQuote } from "@lelantos-org/sdk";

import { env } from "../src/env.js";
import {
    amt,
    awaitBalance,
    awaitOwn,
    DEAD_ADDRESS,
    type Erc20Helpers,
    expectRelayerPaid,
    expectRevert,
    FEE_HEADROOM,
    type Harness,
    REVERT,
    spendItem,
    SWAP_WRAPPER_ABI,
    syncedBalance,
    TEST_NSK,
    TEST_TIMEOUT,
    tokenAddressFor,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import {
    expectSwapEscrowCredited,
    quoteTestSwap,
    ROUTER_OUT,
    setMockNextOut,
    setupSwapVenue,
    SWAP_ASSET_IN,
    SWAP_ASSET_OUT,
    SWAP_PUBLIC_OUT,
    type SwapHarness,
    WRAPPER_AMOUNT_IN,
} from "../src/swap-harness.js";

const ASSET = SWAP_ASSET_IN;
const ASSET_OUT = SWAP_ASSET_OUT;

// The swap stack is deployed only when E2E_SKIP_SWAP is unset. Skipping rather
// than failing in `beforeAll` makes a partial stack report "not exercised".
describe.skipIf(!env.swapEnabled)("masp swap e2e", () => {
    let h: Harness;
    let s: SwapHarness;
    let alice: SdkWallet;
    let mDai: Erc20Helpers;
    let wrapper: ethers.Contract;

    beforeAll(async () => {
        // Three swaps' worth: the happy path plus two negatives, each funding
        // its own note.
        const f = await setupFile({
            nsks: TEST_NSK.swap,
            fund: [{ asset: ASSET, amount: withFee(1_000n) }],
        });
        ({ h } = f);
        ({ alice } = f.w);
        mDai = f.token(ASSET);

        s = await setupSwapVenue(h.payer);
        wrapper = new ethers.Contract(s.wrapperAddress, SWAP_WRAPPER_ABI, h.provider);
    });

    /// A note big enough for one swap.
    const fundOneSwap = () =>
        // Plus headroom: the swap's withdraw leg also funds a note paying the
        // relayer, on top of the pool's unshield fee.
        alice.deposit({ amount: amt(SWAP_PUBLIC_OUT + FEE_HEADROOM), asset: ASSET })
            .then((r) => awaitOwn(alice, r));

    /// Assets, amount and route all come from the quote; the wrapper from the
    /// wallet's network preset.
    const doSwap = (quote: SwapQuote) => alice.swap({ quote });

    /// Run the swap and wait for both legs. The leg-1 change notes come back on
    /// the result, but the leg-2 output-asset note is escrowed by the wrapper
    /// and materialises asynchronously through the relayer's flushBatch, so it
    /// is visible only through a balance poll.
    const swapped = once(async () => {
        await fundOneSwap();
        const quote = await quoteTestSwap(alice);
        await setMockNextOut(h.payer, s, ROUTER_OUT);
        const outBefore = await syncedBalance(alice, ASSET_OUT);

        const r = await doSwap(quote);
        await awaitOwn(alice, r);
        // Leg 1 is an ordinary relayer-served spend, so it funds a fee note in
        // the *input* asset whatever the swap produces on the way out.
        await expectRelayerPaid(r, ASSET);
        const credited = (await awaitBalance(alice, ASSET_OUT, { above: outBefore })) - outBefore;

        // The swap's own operation: the relayer bundles, so its transaction can
        // carry other swaps, each with a `SwapExecuted` of its own.
        return { quote, credited, txHash: r.txHash, item: await spendItem(h.provider, r) };
    });

    it("quote resolves to the allowlisted univ3 adapter", async () => {
        const quote = await quoteTestSwap(alice);
        expect(quote.venue).toBe("univ3");
        expect(quote.gross.amount, "the gross alice named").toBe(SWAP_PUBLIC_OUT);
        expect(quote.net.baseUnits, "what the venue is asked to swap").toBe(WRAPPER_AMOUNT_IN);
        const adapter = quote.route.adapter;
        expect(adapter.toLowerCase()).toBe(s.adapterAddress.toLowerCase());
        expect(await wrapper.adapterAllowed(adapter), "adapter is allowlisted").toBe(true);
    }, TEST_TIMEOUT.SWAP);

    it("happy path: deposit asset 2 -> swap -> fresh asset 3 note", async () => {
        const { quote, credited, txHash, item } = await swapped();

        expect(item.kind, "the operation is a swap, closed by its SwapExecuted").toBe("swap");
        const e = item.swapExecuted!;
        expect(e.depositId, "the wrapper escrowed the output inside the swap").toBe(item.escrowedDepositId);
        expect((e.adapter as string).toLowerCase()).toBe(s.adapterAddress.toLowerCase());
        expect((e.tokenIn as string).toLowerCase()).toBe(tokenAddressFor(ASSET).address.toLowerCase());
        expect((e.tokenOut as string).toLowerCase()).toBe(tokenAddressFor(ASSET_OUT).address.toLowerCase());
        expect(e.amountIn, "wrapper receives publicOut net of the MASP fee").toBe(WRAPPER_AMOUNT_IN);
        expect(e.actualOut, "adapter delivered what the mock was seeded with").toBe(ROUTER_OUT);

        const pulled = await expectSwapEscrowCredited(h.provider, {
            txHash,
            event: e,
            available: e.actualOut as bigint,
            asset: ASSET_OUT,
            credited,
        });
        // The wrapper's floor, restated against the observed pull: it may not
        // settle for less than the quote's minimum.
        expect(pulled).toBeGreaterThanOrEqual(quote.minOut);
    }, TEST_TIMEOUT.SEQUENCE);

    /// A refused swap must be both explained and inert.
    ///
    /// The reason matters because a caller cannot fix a payload they are not
    /// told is wrong: the relayer's `eth_call` pre-flight catches these before
    /// anything is broadcast and reports them as `ContractRejected` (HTTP 400)
    /// carrying the contract's own revert data.
    ///
    /// The effects matter because a rejection that still moved funds would be
    /// worse than one with a vague message. Both balance reads sync first: a
    /// cached read would miss a credit that did land.
    async function expectSwapRefused(
        run: () => Promise<unknown>,
        reason: RegExp,
    ): Promise<void> {
        const outBefore = await syncedBalance(alice, ASSET_OUT);
        const maspBefore = await mDai.balanceOf(env.maspAddress);

        await expectRevert(run(), { code: "RELAYER_REJECTED", match: reason });

        expect(await syncedBalance(alice, ASSET_OUT), "no assetOut credited").toBe(outBefore);
        expect(await mDai.balanceOf(env.maspAddress), "no assetIn left the pool")
            .toBe(maspBefore);
    }

    it("refuses a swap through a non-allowlisted adapter", async () => {
        await fundOneSwap();
        const quote = await quoteTestSwap(alice);

        await expectSwapRefused(
            // The test swaps the quote's adapter for one the wrapper does not
            // allow, which only the pool can refuse. The router's fill is left
            // alone: the pre-flight reverts in `_validate`, before any venue.
            () => doSwap({ ...quote, route: { ...quote.route, adapter: evmAddress(DEAD_ADDRESS) } }),
            REVERT.ADAPTER_NOT_ALLOWED,
        );
    }, TEST_TIMEOUT.SEQUENCE);

    /// A venue that cannot meet `minOut` does not refuse the swap: it lands, the
    /// wrapper escrows the unshielded input back as the refund note, and the
    /// relayer's flush credits it to alice in the input asset.
    it("refunds a swap when the adapter under-delivers vs minOut", async () => {
        await fundOneSwap();
        const quote = await quoteTestSwap(alice);
        // One unit out against a minOut of roughly 99.
        await setMockNextOut(h.payer, s, 1n);
        const inBefore = await syncedBalance(alice, ASSET);
        const outBefore = await syncedBalance(alice, ASSET_OUT);

        const r = await doSwap(quote);
        await awaitOwn(alice, r);
        const fee = await expectRelayerPaid(r, ASSET);
        const item = await spendItem(h.provider, r);

        expect(item.kind, "the operation is a swap").toBe("swap");
        expect(item.swapExecuted, "the venue leg did not complete").toBeUndefined();
        const e = item.swapRefunded!;
        expect(e.depositId, "the refund was escrowed inside the swap").toBe(item.escrowedDepositId);
        expect((e.tokenIn as string).toLowerCase()).toBe(tokenAddressFor(ASSET).address.toLowerCase());
        expect(e.amountIn, "what leg 1 delivered is what was refunded").toBe(WRAPPER_AMOUNT_IN);
        // The mock router's `require`, which the adapter forwards `minOut` to.
        expect(e.reason, "an `Error(string)` from the venue").toBe("0x08c379a0");

        // Leg 1 debits the gross and the relayer's fee note. Computed rather
        // than read back: the sync inside `awaitOwn` can already have picked up
        // the refund note if its flush was quick, and a baseline that counted
        // it would wait for a second credit that never comes.
        const afterSwap = inBefore - SWAP_PUBLIC_OUT - fee;
        // The refund lands through a flush, as the happy path's output note does.
        const refunded = (await awaitBalance(alice, ASSET, { above: afterSwap })) - afterSwap;
        await expectSwapEscrowCredited(h.provider, {
            txHash: r.txHash,
            event: e,
            available: e.amountIn as bigint,
            asset: ASSET,
            credited: refunded,
        });
        expect(await syncedBalance(alice, ASSET_OUT), "no assetOut credited").toBe(outBefore);
    }, TEST_TIMEOUT.SEQUENCE);
});
