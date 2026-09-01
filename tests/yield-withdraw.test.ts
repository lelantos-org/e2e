// Withdrawing from a yield asset: what the depositor is paid once the venue has
// earned, and what the protocol keeps out of it.
//
// A yield id holds notes in NORMALIZED units, not token units. The unit count
// never moves as the venue earns — `publicOut` is a bare count and the circuit
// is untouched — so the growth shows up entirely in what one unit converts to:
// `gross / supply`, where `gross` is the venue position plus the pool's idle
// balance. That is why every expectation below is computed from the pool's own
// `(gross, supply)` pair rather than from a token figure written out by hand.
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
// than growth, would leave every other test in the suite passing.
//
// The arithmetic mirrors `YieldOps._accruePerf` and `YieldOps.unshield`
// exactly — see `helpers` below. Deliberately a mirror rather than an
// approximation: a tolerance wide enough to absorb the rounding would also
// absorb a fee taken at the wrong rate.

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
    expectRelayerPaid,
    FEE_HEADROOM,
    scaleFor,
    snapshotBalances,
    TEST_NSK,
    TEST_TIMEOUT,
    trackedAddrs,
    withFee,
    YIELD_ASSETS,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import { vaultEarn, yieldIndex, yieldRate, yieldSnapshot } from "../src/yield-harness.js";

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

const BPS = 10_000n;

/** `Math.mulDiv(a, b, d, Ceil)`. */
const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;

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
     * The withdrawal, with the pool state captured immediately before it.
     *
     * Read in one place because every expectation is priced off it: once the
     * transaction lands, `gross` and `supply` have both moved and the inputs to
     * the contract's own arithmetic are no longer observable.
     */
    const withdrawn = once(async () => {
        await earned();

        const { state, rate } = await yieldSnapshot(provider, ya);
        const balances = await snapshotBalances(erc20);

        const r = await alice.withdraw({
            to: env.recipientAddress,
            amount: WITHDRAW,
            asset: ASSET,
        });
        await awaitOwn(alice, r);

        return { before: { state, rate, balances }, fee: await expectRelayerPaid(r, ASSET) };
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
        const { state, rate } = before;

        // `_accruePerf` runs first and mints the treasury its units, so the
        // payout is priced against a supply that already includes them — and
        // against a `gross` the accrual left unchanged, since minting units
        // moves no tokens.
        const supply = rate.supply + accruePerf(state, rate).units;

        // Taken in normalized units off the published count, as for a plain
        // asset, then converted at the rate. Rounded down, against the
        // withdrawer, so the pool is never left owing more than it holds.
        const nFee = circuitFee(WITHDRAW);
        const net = ((WITHDRAW - nFee) * rate.gross) / supply;

        await expectBalanceDeltas(erc20, trackedAddrs(), before.balances, { recipient: net });

        // Worth more than the same count was at deposit: this is the whole
        // point of the id, and it fails if the venue's gain never reached the
        // withdrawer.
        expect(net, "the payout carries the accrued yield").toBeGreaterThan(
            baseAmt(WITHDRAW - nFee, ASSET),
        );

        // The shielded balance is debited the gross count plus the relayer's
        // separate fee note — the protocol fee comes out of what left, not out
        // of what stayed.
        const { fee } = await withdrawn();
        expect(alice.balance(ASSET)).toBe(DEPOSIT - WITHDRAW - fee);
    }, TEST_TIMEOUT.SEQUENCE);

    it("charges perfBps of the gain and nothing on the principal", async () => {
        const { before } = await withdrawn();
        const { state, rate } = before;

        const perfBps = BigInt(state.perfBps);
        expect(perfBps, "the deploy registered a performance fee to test").toBeGreaterThan(0n);

        const { cut, units } = accruePerf(state, rate);

        // Growth is the venue's gain and nothing else, so the cut is perfBps of
        // GAIN — the assertion that a fee on principal would fail.
        expect(cut, "charged on the gain, not the position").toBe((GAIN * perfBps) / BPS);
        expect(units, "the cut is large enough to mint units").toBeGreaterThan(0n);

        // Both fees land in the same accumulator: the perf units minted here
        // and the unshield fee taken off the published count.
        const { state: after, rate: post } = await yieldSnapshot(provider, ya);
        expect(
            after.accruedFeeNormalized - state.accruedFeeNormalized,
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
        const supply = rate.supply + units;
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
        const kept = toTokenUnitsAtRate(alice.balance(ASSET), SCALE, post, { round: "down" });
        expect(kept).toBeGreaterThan(baseAmt(alice.balance(ASSET), ASSET));
    }, TEST_TIMEOUT.SEQUENCE);
});

/** What `YieldOps._accruePerf` charges and mints, mirroring the contract. */
interface PerfAccrual {
    /** The treasury's share of the growth, in token units. */
    cut: bigint;
    /** Normalized units minted to the treasury to collect `cut`. */
    units: bigint;
}

const NO_ACCRUAL: PerfAccrual = { cut: 0n, units: 0n };

/**
 * The accrual `unshield` runs before it prices anything, mirrored.
 *
 * `units` is the fee-share solve that leaves the minted units worth exactly
 * `cut` once they dilute the supply.
 */
function accruePerf(
    state: { perfBps: number; lastIdx: bigint },
    rate: { gross: bigint; supply: bigint },
): PerfAccrual {
    const perfBps = BigInt(state.perfBps);
    // Rounded up against the treasury, so rounding cannot manufacture growth.
    const hwm = mulDivCeil(rate.supply * SCALE, state.lastIdx, RAY);
    if (perfBps === 0n || rate.supply === 0n || rate.gross <= hwm) return NO_ACCRUAL;

    const cut = ((rate.gross - hwm) * perfBps) / BPS;
    if (cut === 0n) return NO_ACCRUAL;

    return { cut, units: (cut * rate.supply) / (rate.gross - cut) };
}

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
