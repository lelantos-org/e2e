// Withdrawing at a fixed denomination, and what the change is split into.
//
// `publicOut` is published on chain. A round number that many other users also
// publish blends in; an arbitrary one is near-unique and links the withdrawal
// to whatever deposit funded it. So the SDK keeps a per-token ladder of fixed
// circuit-unit denominations, prefers them when splitting change, and reports
// whether a given amount is on one.
//
// Until SDK 0.32.0 the ladders were a table keyed by mainnet USDC/WETH
// addresses, so this stack's mock tokens resolved to an empty ladder and the
// denomination paths were inert unless a test supplied its own table. The SDK
// now derives every asset's ladder from its `scale` and `decimals`, so there is
// no table to be absent from and nothing to inject — the amounts below are
// chosen to sit on the ladder the asset actually gets.
//
// The ladder is in CIRCUIT units, not human ones. A denomination converted from
// a human amount at runtime moves as the yield index moves, which reproduces
// exactly the fingerprint the ladder exists to remove.

import { formatUnits, universalLadder } from "@lelantos-org/sdk/protocol";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    amt,
    ASSET,
    baseAmt,
    feeFor,
    type Harness,
    netOfGross,
    scaleFor,
    shieldedBalance,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import { depositStep, withdrawStep } from "../src/testkit/steps.js";

/**
 * The ladder this asset gets, ascending, in circuit units.
 *
 * Derived rather than written out: it is a pure function of the asset's `scale`
 * (and `decimals`, which narrows nothing here), so hardcoding it would be a
 * second copy free to drift from the one the wallet actually uses. `{1, 2, 5} ×
 * 10^e` over the universal window, which at `scale = 1e10` starts at 1e5
 * circuit units — four orders of magnitude above the amounts this file used
 * when it supplied its own ladder.
 */
const LADDER = universalLadder({ scale: scaleFor(ASSET) });

/** Comfortably above `WITHDRAW` plus its fee, and itself a rung. */
const DEPOSIT = amt(2_000_000n);
/** On the ladder. What the chain publishes, and what the fee is skimmed from. */
const WITHDRAW = amt(500_000n);
/**
 * Deliberately between rungs, and exactly halfway: 350k is 150k from both 200k
 * and 500k, which is what makes it a test of the tie rule and not just of the
 * gap. Ties go to the smaller, so the suggestion must be 200k.
 */
const OFF_LADDER = amt(350_000n);

describe("withdraw at a fixed denomination", () => {
    let h: Harness;
    let alice: SdkWallet;
    let decimals: number;

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.denominated,
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT) }],
        });
        ({ h } = f);
        ({ alice } = f.w);

        // The relayer's `/chains` carries no `decimals` for these mock tokens —
        // the indexer has not read them — and the registry answers from that
        // list first. `previewWithdraw` formats a human net, so it needs them.
        // A refresh re-reads the asset from the chain itself, where the
        // adapter's `tokenMeta` supplies both `decimals` and `symbol`.
        const info = await alice.asset(ASSET, { refresh: true });
        if (info.decimals === undefined) throw new Error(`asset ${ASSET}: refresh resolved no decimals`);
        decimals = info.decimals;
    });

    const deposited = once(() => depositStep(h, alice, { amount: DEPOSIT, asset: ASSET }));

    const withdrawn = once(async () => {
        await deposited();
        return withdrawStep(h, alice, { recipient: env.recipientAddress, gross: WITHDRAW, asset: ASSET });
    });

    it("reports the ladder, and that the amount is on it", async () => {
        await deposited();
        const p = await alice.previewWithdraw({ gross: WITHDRAW, asset: ASSET });

        expect(p.hasLadder, "the derived ladder reached the AssetInfo").toBe(true);
        expect(p.denominations).toEqual([...LADDER]);
        expect(p.onLadder).toBe(true);
        expect(p.suggestion, "nothing to suggest for an amount already on it").toBeUndefined();

        // The gross is what gets published; the recipient receives it less the
        // protocol fee. Both numbers, from one call, before proving anything.
        expect(p.publicOut).toBe(WITHDRAW);
        expect(p.net).toBe(netOfGross(WITHDRAW));
        expect(p.fee).toBe(feeFor(WITHDRAW));
        expect(p.net + p.fee, "every unit accounted for").toBe(baseAmt(WITHDRAW));
    }, TEST_TIMEOUT.DEPOSIT);

    it("offers one labelled choice per rung", async () => {
        await deposited();
        const choices = await alice.withdrawDenominations(ASSET);

        expect(choices.map((c) => c.value)).toEqual([...LADDER]);
        // Each netLabel is what would actually arrive for its rung, formatted in
        // the token's own decimals — the figure a picker shows beside the gross.
        for (const c of choices) {
            expect(c.netLabel, `net of ${c.label}`).toBe(formatUnits(netOfGross(c.value), decimals));
        }
    }, TEST_TIMEOUT.DEPOSIT);

    /// Off-ladder is not an error — nothing rejects it — but it is a privacy
    /// regression the caller has to be able to see. Asserted through the pure
    /// preview rather than a second withdrawal: it costs no proof, and the
    /// behaviour under test is the reporting, not the submission.
    it("flags an amount between rungs and names the nearest", async () => {
        await deposited();
        const p = await alice.previewWithdraw({ gross: OFF_LADDER, asset: ASSET });

        expect(p.hasLadder).toBe(true);
        expect(p.onLadder).toBe(false);
        // Equidistant from 200k and 500k; the tie goes to the smaller, so a
        // suggestion never silently costs more than was asked for.
        expect(p.suggestion).toBe(amt(200_000n));
    }, TEST_TIMEOUT.DEPOSIT);

    it("publishes exactly the denomination and pays the recipient net of the fee", async () => {
        const { erc20, fee, accrued } = await withdrawn();

        // The MASP is debited only what the recipient actually receives; the
        // protocol fee stays behind as accrued fee.
        const net = netOfGross(WITHDRAW);
        expect(erc20).toEqual({ payer: 0n, masp: -net, recipient: net });
        expect(accrued, "unshield fee").toBe(feeFor(WITHDRAW));

        // The shielded balance is debited the gross, not the net: the fee comes
        // out of what left, not out of what stayed. The relayer's own fee is a
        // second, separate note off the same inputs.
        expect(await shieldedBalance(alice, ASSET)).toBe(DEPOSIT - WITHDRAW - fee);
    }, TEST_TIMEOUT.SEQUENCE);

    /// The half that makes a denominated withdrawal repeatable. Splitting change
    /// evenly would leave notes at arbitrary values, so the *next* withdrawal
    /// would have nothing on the ladder to spend and would have to publish an
    /// arbitrary `publicOut` after all.
    it("splits the change onto the ladder, leaving exactly one residual note", async () => {
        const { fee } = await withdrawn();

        // Every unspent note is change from this file's single spend: the
        // deposit note was consumed by it, and the relayer's fee note is
        // addressed to the relayer, not to alice.
        const change = (await alice.notes({ spent: false, asset: ASSET }))
            .map((n) => n.value)
            // Unused output slots are minted at zero; they are padding, not change.
            .filter((v) => v > 0n)
            .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

        // The one deposit note covers the gross and the relayer's fee, leaving
        // 1.5M less the fee across the five slots the fee note does not take.
        // `decompose` fills all but the last slot greedily, largest rung first:
        // 1M, then 200k twice, after which less than the ladder's 100k floor
        // is left and goes into the held-back slot as the single residual.
        // That walk holds for any fee under 100k; a larger one lands on other
        // rungs, and is a relayer pricing change rather than a split bug.
        expect(fee, "fee small enough for the split derived below").toBeLessThan(amt(100_000n));
        const residual = amt(100_000n) - fee;
        expect(change, `change was ${change.join(", ")}`).toEqual([
            amt(1_000_000n), amt(200_000n), amt(200_000n), residual,
        ]);
        expect(change.reduce((a, b) => a + b, 0n), "change is the whole remaining balance")
            .toBe(await shieldedBalance(alice, ASSET));

        // Two off-ladder notes would mean change was split evenly and the
        // ladder ignored.
        expect(change.filter((v) => !LADDER.includes(v)), "the residual is the only off-ladder note")
            .toEqual([residual]);
    }, TEST_TIMEOUT.SEQUENCE);
});
