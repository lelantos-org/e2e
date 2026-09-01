// Where the tokens a yield withdrawal pays out actually come from.
//
// A yield id's `gross` has two legs: the pool's own idle balance and the
// position it holds at the venue. Only the first can be paid out directly, so
// `YieldOps._ensureIdle` decides, per withdrawal, whether the pool can settle
// out of the buffer or has to redeem from the vault first — and a redemption
// takes the shortfall PLUS the buffer it wants left behind, so the withdrawals
// that follow do not each reach the venue.
//
// None of that is visible from the recipient's balance. A pool that redeemed
// the whole position on every exit, one that never refilled its buffer, and one
// that got it exactly right all pay the same withdrawer the same amount. So
// this file asserts the split rather than the payout: which leg moved, by how
// much, and what idle was left at.
//
// Three cases, in the order the pool drains through them:
//
//   1. a payout the buffer covers          — the venue is never touched
//   2. a payout it does not                — shortfall plus refill, in one draw
//   3. the same, against a capped venue    — the refill is best-effort and the
//                                            payout is not
//
// The third is the one that cannot be reached by sizing alone: `maxWithdraw`
// has to be short. `setVaultLiquidityCap` supplies that, and `afterAll` lifts
// it — the suite shares one vault per asset across every file.
//
// This runs on the yield id for WETH, which nothing else in the suite deposits
// into. The id is shared state and its `(gross, supply)` ratio is the input to
// every figure below; on the mDAI yield id these cases would be reading a pool
// that `yield-withdraw.test.ts` had moved, and moving one it reads.

import { ethers } from "ethers";

import type { CircuitAmount } from "@lelantos-org/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env, type YieldAssetEnv } from "../src/env.js";
import {
    amt,
    awaitOwn,
    type Erc20Helpers,
    expectBalanceDeltas,
    expectPoolSettled,
    expectRelayerPaid,
    FEE_HEADROOM,
    type Observed,
    observeYield,
    scaleFor,
    TEST_NSK,
    TEST_TIMEOUT,
    trackedAddrs,
    withFee,
    YIELD_ASSETS,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import {
    LIQUIDITY_UNCAPPED,
    setVaultLiquidityCap,
    venueAssets,
    yieldSnapshot,
} from "../src/yield-harness.js";
import { refillFor, unshieldNet } from "../src/yield-mirror.js";

/** The lending id for WETH — plain id 1's token, registered again at 4. */
const ASSET = YIELD_ASSETS.WETH;
const SCALE = scaleFor(ASSET);

const DEPOSIT = amt(2_000_000n);

/**
 * A withdrawal the buffer covers on its own.
 *
 * The buffer is `bufferBps` of `gross` — 5% as the stack deploys it — so a
 * publication of 1% of the supply converts to well under it. The relationship
 * is asserted rather than trusted: the case reads the pool's own `idle` and
 * fails if the payout it sized does not actually fit inside it.
 */
const SMALL = amt(20_000n);

/** A withdrawal it does not: a quarter of the supply against a 5% buffer. */
const LARGE = amt(500_000n);

/** One withdrawal, with the pool observed on either side of it. */
interface Withdrawal {
    before: Observed;
    after: Observed;
    /** What the payout was priced at, mirrored from the `before` snapshot. */
    net: bigint;
}

describe("yield: where a withdrawal's tokens come from", () => {
    let alice: SdkWallet;
    let erc20: Erc20Helpers;
    let provider: ethers.JsonRpcProvider;
    let payer: ethers.Wallet;
    let ya: YieldAssetEnv;

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.yieldLiquidity,
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT + FEE_HEADROOM, ASSET) }],
        });
        ({ alice } = f.w);
        erc20 = f.token(ASSET);
        ({ provider, payer } = f.h);
        ya = env.yield.asset(ASSET);

        // The relayer's `/chains` carries no decimals for a mock token, and the
        // yield branch additionally needs `yieldEnabled` and the pool's `rate`
        // to quote anything at all.
        await alice.asset(ASSET, { refresh: true });
    });

    // Restores the shared vault whether or not the capped case got that far.
    afterAll(async () => {
        await setVaultLiquidityCap(payer, ya, LIQUIDITY_UNCAPPED);
    });

    const observe = () => observeYield(provider, ya, erc20);

    /**
     * Publish `amount` and observe the pool on both sides of it.
     *
     * `net` is priced off the `before` snapshot because that is the only block
     * in which the contract's own inputs are still readable: once the
     * transaction lands, `gross` and `supply` have both moved.
     */
    const withdraw = async (amount: CircuitAmount): Promise<Withdrawal> => {
        const before = await observe();
        const net = unshieldNet(amount, before, SCALE);

        const r = await alice.withdraw({ to: env.recipientAddress, amount, asset: ASSET });
        await awaitOwn(alice, r);
        // Read as the relayer, not as the payer: a fee note the relayer cannot
        // recover leaves every balance below correct and the relayer unpaid.
        await expectRelayerPaid(r, ASSET);

        return { before, after: await observe(), net };
    };

    const deposited = once(async () => {
        const r = await alice.deposit({ amount: DEPOSIT, asset: ASSET });
        await awaitOwn(alice, r);

        // The deposit is what funds the venue: `settleShield` books the whole
        // pull as idle and then supplies everything above the buffer target. A
        // pool that left it all idle would pass cases 1 and 2 by never needing
        // the venue at all.
        const s = await yieldSnapshot(provider, ya);
        expect(venueAssets(s), "the deposit reached the venue").toBeGreaterThan(0n);
        return s;
    });

    const bufferPaid = once(async () => {
        await deposited();
        return await withdraw(SMALL);
    });

    const venueDrawn = once(async () => {
        await bufferPaid();
        return await withdraw(LARGE);
    });

    /**
     * The same draw again, against a venue that cannot service all of it.
     *
     * The cap is placed between the shortfall and the shortfall plus the
     * refill, so the vault can cover what the withdrawer is owed and not the
     * top-up the pool wanted on the way past. Sized off the snapshot the
     * withdrawal itself is priced from, so the two agree by construction —
     * nothing else transacts on this id between the two reads.
     */
    const cappedDraw = once(async () => {
        await venueDrawn();

        const snap = await yieldSnapshot(provider, ya);
        const net = unshieldNet(LARGE, snap, SCALE);
        const short = net - snap.state.idle;
        const refill = refillFor(snap.rate.gross, net, snap.state.bufferBps);
        expect(short, "the payout still needs the venue").toBeGreaterThan(0n);
        expect(refill, "and there is a refill to come up short of").toBeGreaterThan(1n);

        const cap = short + refill / 2n;
        await setVaultLiquidityCap(payer, ya, cap);

        return { ...(await withdraw(LARGE)), cap, short, refill };
    });

    it("pays out of the idle buffer without touching the venue", async () => {
        const { before, after, net } = await bufferPaid();

        // The precondition the case is about. A `SMALL` that outgrew the buffer
        // would turn this into a second copy of the draw case, silently.
        expect(net, "the buffer covers the payout").toBeLessThanOrEqual(before.state.idle);

        expect(
            venueAssets(after),
            "a payout the buffer covers never reaches the venue",
        ).toBe(venueAssets(before));

        // `_ensureIdle` returns early, so the buffer is spent down rather than
        // topped back up: the refill only rides along with a draw that was
        // going to the venue anyway.
        expect(after.state.idle, "idle is spent down, not refilled").toBe(
            before.state.idle - net,
        );

        await expectBalanceDeltas(erc20, trackedAddrs(), before.balances, { recipient: net });
        expectPoolSettled(before, after, net);
    }, TEST_TIMEOUT.SEQUENCE);

    it("draws the shortfall and the refill in one hop when idle is short", async () => {
        const { before, after, net } = await venueDrawn();

        expect(net, "the payout exceeds the buffer").toBeGreaterThan(before.state.idle);

        const refill = refillFor(before.rate.gross, net, before.state.bufferBps);
        const drawn = venueAssets(before) - venueAssets(after);

        // One draw, sized for both jobs: what the withdrawer is owed beyond the
        // buffer, and the buffer the pool wants standing once they have gone. A
        // pool that drew only the shortfall would leave idle at zero here and
        // send the next withdrawal of any size back to the venue.
        expect(drawn, "shortfall plus refill, in a single redemption").toBe(
            net - before.state.idle + refill,
        );
        expect(after.state.idle, "and the buffer is standing again").toBe(refill);

        await expectBalanceDeltas(erc20, trackedAddrs(), before.balances, { recipient: net });
        expectPoolSettled(before, after, net);
    }, TEST_TIMEOUT.SEQUENCE);

    it("pays in full from a venue too illiquid to refill the buffer too", async () => {
        const { before, after, net, cap, refill } = await cappedDraw();

        // The cap, not the position, is what the venue would serve: the vault
        // still reports the assets it holds.
        expect(venueAssets(before), "the position is intact").toBeGreaterThan(cap);

        // The draw is clamped to what the venue can service. It covers the
        // shortfall in full and gets part of the way through the refill.
        expect(venueAssets(before) - venueAssets(after), "the draw is clamped to the cap").toBe(cap);

        // The withdrawer is paid in full regardless: the refill is best-effort
        // and the payout is not, so a venue short of the top-up does not become
        // a venue that short-changes an exit.
        await expectBalanceDeltas(erc20, trackedAddrs(), before.balances, { recipient: net });

        // What the pool held, plus what it managed to draw, less what it paid:
        // the part of the refill the cap let through.
        expect(after.state.idle, "the buffer got what the cap allowed").toBe(
            before.state.idle + cap - net,
        );
        expect(after.state.idle, "which is short of the target").toBeLessThan(refill);
        expect(
            after.state.idle,
            "and not nothing — a clamped draw still brings back what it can",
        ).toBeGreaterThan(0n);

        expectPoolSettled(before, after, net);
    }, TEST_TIMEOUT.SEQUENCE);
});
