// Withdrawing from a yield asset: what the depositor is paid once the venue has
// earned, what the pool had to do to pay it, and what the protocol keeps out of
// it.
//
// A yield id holds notes in NORMALIZED units, not token units. The unit count
// never moves as the venue earns — `publicOut` is a bare count and the circuit
// is untouched — so the growth shows up entirely in what one unit converts to:
// `gross / supply`, where `gross` is the venue position plus the pool's idle
// balance. That is why every expectation below is computed from the pool's own
// `(gross, supply)` pair rather than from a token figure written out by hand.
// The arithmetic lives in `src/yield-mirror.ts`, which mirrors `YieldOps`
// exactly and explains why it is a mirror rather than an approximation.
//
// Two fees are in play and they are taken in different places:
//
//   * `withdrawBps` — the protocol unshield fee, taken in normalized units off
//     the count being published, exactly as it is for a plain asset.
//   * `perfBps` — the performance fee on YIELD ONLY, which cannot be deducted
//     from the payout (that would need the note's cost basis, and notes are
//     shielded and fungible). It is charged by MINTING normalized units to the
//     treasury, which dilutes every holder by the treasury's share of the gain.
//
// Both are asserted here, and the second is the reason this file exists: a
// performance fee that silently charged 0%, or charged against principal rather
// than growth, would leave every other test in the suite passing. The last
// three cases follow the value the rest of the file only accounts for: out of
// the venue and into the recipient's hands, and out of the accumulator and into
// the treasury's.

import { ethers } from "ethers";

import { RAY, toTokenUnitsAtRate } from "@lelantos-org/sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { env, type YieldAssetEnv } from "../src/env.js";
import {
    amt,
    awaitOwn,
    baseAmt,
    circuitFee,
    type Erc20Helpers,
    expectBalanceDeltas,
    expectPoolSettled,
    expectRelayerPaid,
    FEE_HEADROOM,
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
    accrueYieldPerf,
    poolTreasury,
    sweepYieldFee,
    vaultEarn,
    venueAssets,
    yieldIndex,
    yieldRate,
} from "../src/yield-harness.js";
import {
    accruePerf,
    BPS,
    refillFor,
    supplyAfterAccrual,
    toUnderlying,
    unshieldNet,
} from "../src/yield-mirror.js";

/** The lending id for mDAI — plain id 2's token, registered again at 5. */
const ASSET = YIELD_ASSETS.MDAI;
const SCALE = scaleFor(ASSET);

const DEPOSIT = amt(2_000_000n);
const WITHDRAW = amt(500_000n);

/**
 * What the vault earns, in token units: 10% of the deposited principal.
 *
 * Large enough that the treasury's cut of it stays well clear of the rounding
 * floor — a gain small enough to round `m` to zero would pass an assertion that
 * the fee was "correct" while proving nothing.
 */
const GAIN = baseAmt(DEPOSIT, ASSET) / 10n;

describe("yield: accrual and fees on withdraw", () => {
    let alice: SdkWallet;
    let erc20: Erc20Helpers;
    let provider: ethers.JsonRpcProvider;
    let payer: ethers.Wallet;
    /** The deployed triple for this id: token, vault, venue. */
    let ya: YieldAssetEnv;

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.yieldWithdraw,
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT + FEE_HEADROOM, ASSET) }],
        });
        ({ alice } = f.w);
        erc20 = f.token(ASSET);
        ({ provider, payer } = f.h);
        ya = env.yield.asset(ASSET);

        // As in `denominated-withdraw`: the relayer's `/chains` carries no
        // decimals for a mock token, and the yield branch additionally needs
        // `yieldEnabled` and the pool's `rate` to quote anything at all.
        await alice.asset(ASSET, { refresh: true });
    });

    const observe = () => observeYield(provider, ya, erc20);

    const deposited = once(async () => {
        const r = await alice.deposit({ amount: DEPOSIT, asset: ASSET });
        await awaitOwn(alice, r);
    });

    /**
     * Credit the venue's vault with `GAIN`, funded by the payer.
     *
     * The payer mints and approves it here rather than in `beforeAll`: the mock
     * pulls the tokens in, so the gain is real underlying backing the position
     * and not a bookkeeping entry the pool's own `gross` would disagree with.
     */
    const earned = once(async () => {
        await deposited();

        await (await erc20.contract.mint(env.payerAddress, GAIN)).wait();
        await (await erc20.contract.approve(ya.vault, GAIN)).wait();

        const before = await yieldRate(provider, ya);
        await vaultEarn(payer, ya, GAIN);
        return { before };
    });

    /**
     * The withdrawal, with the pool state captured on either side of it.
     *
     * Both reads live here because every expectation is priced off them. The
     * `before` read is the only chance to see the inputs to the contract's own
     * arithmetic — once the transaction lands, `gross` and `supply` have both
     * moved. The `after` read is shared for a different reason: taken inside
     * each `it` instead, this file would assert a pool state that a later `it`
     * could have moved, and the cases would only pass in the order they happen
     * to be written in.
     */
    const withdrawn = once(async () => {
        await earned();

        const before = await observe();

        const r = await alice.withdraw({
            to: env.recipientAddress,
            amount: WITHDRAW,
            asset: ASSET,
        });
        await awaitOwn(alice, r);

        return { before, after: await observe(), fee: await expectRelayerPaid(r, ASSET) };
    });

    it("moves the index above RAY once the venue earns", async () => {
        const { before } = await earned();

        // Units outstanding are untouched by a gain: the growth is entirely in
        // what one unit is worth.
        const after = await yieldRate(provider, ya);
        expect(after.supply, "a gain mints no units").toBe(before.supply);
        expect(after.gross - before.gross, "the whole gain reached the pool's gross").toBe(GAIN);

        // The reported index is derived and floored, so it is asserted as a
        // direction rather than a figure; the payout below uses the pair.
        expect(await yieldIndex(provider, ya)).toBeGreaterThan(RAY);

        // The shielded balance is a unit count and does not move either, but
        // those units are now worth more than they cost.
        expect(alice.balance(ASSET)).toBe(DEPOSIT);
        expect(
            toTokenUnitsAtRate(alice.balance(ASSET), SCALE, after, { round: "down" }),
            "the depositor's units revalue with the venue",
        ).toBeGreaterThan(baseAmt(DEPOSIT, ASSET));
    }, TEST_TIMEOUT.SEQUENCE);

    it("pays the recipient at the accrued rate, net of the withdraw fee", async () => {
        const { before } = await withdrawn();

        // `_accruePerf` runs first and mints the treasury its units, so the
        // payout is priced against a supply that already includes them — and
        // against a `gross` the accrual left unchanged, since minting units
        // moves no tokens. The unshield fee comes off the published count in
        // normalized units, as for a plain asset, and the remainder converts at
        // that rate, rounded down against the withdrawer.
        const net = unshieldNet(WITHDRAW, before, SCALE);

        await expectBalanceDeltas(erc20, trackedAddrs(), before.balances, { recipient: net });

        // Worth more than the same count was at deposit: this is the whole
        // point of the id, and it fails if the venue's gain never reached the
        // withdrawer.
        expect(net, "the payout carries the accrued yield").toBeGreaterThan(
            baseAmt(WITHDRAW - circuitFee(WITHDRAW), ASSET),
        );

        // The shielded balance is debited the gross count plus the relayer's
        // separate fee note — the protocol fee comes out of what left, not out
        // of what stayed.
        const { fee } = await withdrawn();
        expect(alice.balance(ASSET)).toBe(DEPOSIT - WITHDRAW - fee);
    }, TEST_TIMEOUT.SEQUENCE);

    it("draws the shortfall from the venue and refills the buffer", async () => {
        const { before, after } = await withdrawn();
        const net = unshieldNet(WITHDRAW, before, SCALE);

        // The precondition the rest of this case rests on. Asserted rather than
        // assumed: a `WITHDRAW` small enough to be paid out of the idle buffer
        // would satisfy every expectation below without the venue ever being
        // touched, and would go on passing if the draw path broke entirely.
        expect(net, "the payout exceeds the idle buffer").toBeGreaterThan(before.state.idle);

        // What `_ensureIdle` pulled back from the venue, read off the pool's own
        // books: idle rose by the draw and then fell by the payout.
        const drawn = after.state.idle + net - before.state.idle;

        // The venue leg moved by exactly that much. This is the cross-check the
        // recipient-side assertion cannot make on its own — the pool can pay out
        // the right amount while accounting for the position it paid from
        // wrongly, and only a divergence here would say so.
        expect(
            venueAssets(before) - venueAssets(after),
            "the venue position fell by what the pool booked as drawn",
        ).toBe(drawn);

        // A draw takes the shortfall plus the buffer the pool wants left behind
        // once `net` has gone, so idle lands on that target rather than on zero
        // and the withdrawals that follow do not each reach the venue.
        expect(after.state.idle, "the buffer was refilled in the same hop").toBe(
            refillFor(before.rate.gross, net, before.state.bufferBps),
        );

        expectPoolSettled(before, after, net);
    }, TEST_TIMEOUT.SEQUENCE);

    it("charges perfBps of the gain and nothing on the principal", async () => {
        const { before, after } = await withdrawn();
        const { state, rate } = before;

        const perfBps = BigInt(state.perfBps);
        expect(perfBps, "the deploy registered a performance fee to test").toBeGreaterThan(0n);

        const { cut, units } = accruePerf(state, rate, SCALE);

        // Growth is the venue's gain and nothing else, so the cut is perfBps of
        // GAIN — the assertion that a fee on principal would fail.
        expect(cut, "charged on the gain, not the position").toBe((GAIN * perfBps) / BPS);
        expect(units, "the cut is large enough to mint units").toBeGreaterThan(0n);

        // Both fees land in the same accumulator: the perf units minted here
        // and the unshield fee taken off the published count.
        expect(
            after.state.accruedFeeNormalized - state.accruedFeeNormalized,
            "perf fee plus unshield fee, both in normalized units",
        ).toBe(units + circuitFee(WITHDRAW));

        // And the depositor keeps the rest of the gain.
        //
        // Through the pool's own accounting rather than by apportioning the
        // gain across alice's notes: units also move to the treasury as the
        // unshield fee, so a per-note share would have to model both fees, and
        // would end up asserting its own arithmetic rather than the contract's.
        //
        // The fee-share solve mints `units` so that the treasury's holding is
        // worth exactly `cut` once it dilutes the supply — that is what makes
        // the charge perfBps of the growth and not a unit more. The mint is
        // floored, so the treasury lands at or just below `cut`, never above.
        const supply = supplyAfterAccrual(before, SCALE);
        const treasury = (units * rate.gross) / supply;
        /// One normalized unit, at the post-accrual rate. The floor above can
        /// cost the treasury up to this much, and nothing can cost it more.
        const perUnit = rate.gross / supply;

        expect(treasury, "the treasury never takes more than its cut").toBeLessThanOrEqual(cut);
        expect(cut - treasury, "and lands within a unit of it").toBeLessThanOrEqual(perUnit);

        // What the pre-existing units are worth once the treasury's mint has
        // diluted them: the pool's gross before the venue earned, plus the
        // whole gain except the treasury's share. `gross` before the gain is
        // measured independently, from before `vaultEarn` ran.
        const { before: preGain } = await earned();
        const holders = (rate.supply * rate.gross) / supply;
        expect(
            absDiff(holders, preGain.gross + GAIN - treasury),
            "the depositors keep every unit of the gain the treasury did not take",
        ).toBeLessThanOrEqual(perUnit);

        // And alice's own remaining units are worth more than they cost her.
        const kept = toTokenUnitsAtRate(alice.balance(ASSET), SCALE, after.rate, { round: "down" });
        expect(kept).toBeGreaterThan(baseAmt(alice.balance(ASSET), ASSET));
    }, TEST_TIMEOUT.SEQUENCE);

    /**
     * The treasury's claim on what the withdrawal accrued.
     *
     * Deliberately the last stage in the file: a sweep clears the accumulator
     * and moves `gross`, so every case above reads a pool it has not touched.
     * The `once` chain makes that a dependency rather than an ordering
     * convention — each case pulls in exactly the prefix it needs, and only the
     * two below pull in the sweep.
     */
    const swept = once(async () => {
        const { after: settled } = await withdrawn();

        // Accrued first, as its own transaction, so the units the sweep
        // converts are readable beforehand: `sweepNormalized` accrues too and
        // then clears what it accrued in the same call, which would leave the
        // size of its own input unobservable. Nothing has earned since the
        // withdrawal, so this brings in nothing new — which the case below
        // asserts rather than assumes.
        await accrueYieldPerf(payer, ya);

        const addrs = { ...trackedAddrs(), treasury: await poolTreasury(provider) };
        const before = await observeYield(provider, ya, erc20, addrs);
        const fee = await sweepYieldFee(payer, ya);

        return { settled, addrs, before, after: await observeYield(provider, ya, erc20, addrs), fee };
    });

    it("pays the whole accrued fee out to the pool's treasury", async () => {
        const { settled, addrs, before, after, fee } = await swept();

        expect(
            before.state.accruedFeeNormalized,
            "the withdrawal left units to claim, and nothing accrued on top of them",
        ).toBe(settled.state.accruedFeeNormalized);
        expect(before.state.accruedFeeNormalized).toBeGreaterThan(0n);

        // The whole accumulator goes in one call, and what it converts to is
        // the floored value of those units at the rate they are worth now —
        // both fees having ridden the venue since they were taken.
        expect(fee.units, "the sweep retires the whole accumulator").toBe(
            before.state.accruedFeeNormalized,
        );
        expect(fee.amount, "converted at the pool's own rate, floored").toBe(
            toUnderlying(fee.units, before.rate, SCALE),
        );
        expect(fee.amount, "and is worth something to claim").toBeGreaterThan(0n);

        // It reached the owner-pinned destination, and only it. This is what
        // the accumulator's own arithmetic cannot say: a sweep that credited
        // the wrong address, or credited nobody, clears it identically.
        await expectBalanceDeltas(erc20, addrs, before.balances, {
            treasury: fee.amount,
            recipient: 0n,
        });
        expect(after.state.accruedFeeNormalized, "the accumulator is cleared").toBe(0n);

        // Settlement is lazy precisely so it can be served out of the buffer:
        // the treasury's cut is a fraction of a gain, which is a fraction of
        // the pool, so a sweep should not have to reach the venue at all.
        if (fee.amount <= before.state.idle) {
            expect(venueAssets(after), "the buffer covered it").toBe(venueAssets(before));
            expect(after.state.idle, "and was spent down for it").toBe(
                before.state.idle - fee.amount,
            );
        } else {
            expect(after.state.idle, "and the buffer was refilled on the way out").toBe(
                refillFor(before.rate.gross, fee.amount, before.state.bufferBps),
            );
        }
        expectPoolSettled(before, after, fee.amount);
    }, TEST_TIMEOUT.SEQUENCE);

    it("takes the fee out of the treasury's units, not the note holders'", async () => {
        const { addrs, before, after, fee } = await swept();

        // The units that left were the treasury's own, so retiring them moves
        // `gross` and `supply` together and `totalNormalized` not at all.
        expect(after.rate.supply, "the swept units are gone from the supply").toBe(
            before.rate.supply - fee.units,
        );
        expect(after.state.totalNormalized, "the depositors' units are not touched").toBe(
            before.state.totalNormalized,
        );

        // Which leaves what alice holds worth what it was worth. Within a unit,
        // because the payout is floored and the remainder stays behind as
        // surplus backing rather than following the treasury out.
        const held = alice.balance(ASSET);
        expect(
            absDiff(
                toTokenUnitsAtRate(held, SCALE, after.rate, { round: "down" }),
                toTokenUnitsAtRate(held, SCALE, before.rate, { round: "down" }),
            ),
            "a sweep does not dilute the note holders",
        ).toBeLessThanOrEqual(after.rate.gross / after.rate.supply);

        // And a second sweep has nothing to convert. It must not manufacture a
        // payout out of that surplus, which is the note holders' and not the
        // treasury's.
        expect(await sweepYieldFee(payer, ya), "an empty accumulator sweeps nothing").toEqual({
            units: 0n,
            amount: 0n,
        });
        await expectBalanceDeltas(erc20, addrs, before.balances, { treasury: fee.amount });
    }, TEST_TIMEOUT.SEQUENCE);
});

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
