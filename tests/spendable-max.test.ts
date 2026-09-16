// What the wallet says it can spend is exactly what it can spend.
//
// `spendableMax` is what a UI's "max" button reads, and it is a prediction: the
// selector, not this function, decides what a spend may touch. The two share
// `partitionSpendable` so they cannot drift (`sdk/src/wallet/selection/`), and
// this file pins that from the outside — take the maximum, send exactly it, and
// check that what is left is precisely what the same call said it was holding
// back, rule by rule.
//
// Five deposits, because the interesting figure only exists above the circuit's
// input arity: with `N_IN = 4` slots and five notes, one note is spendable in
// principle and unreachable by any single spend, which is what `withheld.slots`
// names. That also makes `Balance`'s split non-trivial to check.

import { beforeAll, describe, expect, it } from "vitest";

import type { Balance } from "@lelantos-org/sdk";

import {
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    errorText,
    expectRelayerPaid,
    FEE_HEADROOM,
    type Harness,
    isWalletError,
    mineIfAnvil,
    N_IN,
    shieldedBalance,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

/**
 * Five deposits, all different, and no four of them reachable together with the
 * fifth: the four largest sum to `TOP_FOUR` and the smallest is left over.
 *
 * `N_IN` is the circuit's input arity (4), so a single spend can consume at most
 * four of these notes.
 */
const DEPOSITS = [40n, 60n, 80n, 120n, 200n] as const;
const TOTAL = 500n;
/** The four largest: 200 + 120 + 80 + 60. What one spend can reach. */
const TOP_FOUR = 460n;
/** The one left over, which no single spend can reach: `withheld.slots`. */
const BEYOND_SLOTS = 40n;

/** Sent out of the last note, in the cooldown case, so it leaves change behind. */
const COOLDOWN_SEND = amt(10n);

/**
 * Slack, in blocks, on the cooldown window the cooldown case sets by hand.
 *
 * The default window is one block (`DEFAULT_COOLDOWN_BLOCKS`,
 * `sdk/src/wallet/selection/types.ts`) and anvil runs with `--block-time=1`
 * (`src/services.ts`), so a note is past the default window about a second after
 * it lands — long before the indexer surfaces it and the wallet can be asked.
 * There is therefore no way to observe fresh change under `withheld.cooldown` at
 * the default setting without racing the chain.
 *
 * The rule itself is still exercised exactly, by naming the window instead of
 * waiting for it: the case asks for `age + GUARD` blocks, which withholds the
 * note now (it would take `GUARD` blocks of drift between reading the tip and
 * the wallet reading it for that to be wrong) and releases it deterministically
 * after `GUARD` blocks are mined, since mining only ever raises the tip.
 */
const COOLDOWN_GUARD = 60;

const describeError = (e: unknown): string => (e instanceof Error ? errorText(e) : String(e));

/**
 * `Balance`'s documented split: `total === spendable + withheld.reserved +
 * withheld.cooldown + withheld.dust + withheld.slots`
 * (`sdk/src/wallet/types/sync.ts`).
 *
 * Checked at every point this file reads a balance: each case moves value
 * between exactly these buckets, so a bucket that double-counted or dropped
 * value would show here.
 */
function expectBalanceAddsUp(b: Balance): void {
    const { reserved, cooldown, dust, slots } = b.withheld;
    expect(b.spendable + reserved + cooldown + dust + slots, "balance split adds up").toBe(b.total);
}

describe("spendable max and balance accounting", () => {
    let h: Harness;
    let alice: SdkWallet;
    let bob: SdkWallet;

    beforeAll(async () => {
        // Each deposit pulls principal, the pool's 5% and a note paying whoever
        // flushes it. `fundPayerForAsset` mints one `FEE_HEADROOM` of slack on
        // top; a second is added here because five deposits pay five of those
        // flush notes.
        ({ h, w: { alice, bob } } = await setupFile({
            nsks: TEST_NSK.spendableMax,
            fund: [{ asset: ASSET, amount: withFee(TOTAL + FEE_HEADROOM) }],
        }));
    });

    /**
     * What the relayer charges for a transfer in `ASSET`, from the wallet's own
     * quote, which is "computed by the same code the operation runs"
     * (`sdk/src/wallet/types/quotes.ts`).
     */
    const quotedTransferFee = async (): Promise<bigint> => {
        const quote = await alice.quoteFee("transfer");
        expect(quote.charged, "this stack's relayer charges for a transfer").toBe(true);
        const option = quote.options.find((o) => o.asset.id === ASSET);
        if (!option) throw new Error(`the relayer quoted no transfer fee in asset ${ASSET}`);
        return option.amount;
    };

    const deposited = once(async () => {
        // Sequential: each deposit waits on its own flush, and the values have to
        // land as five separate notes rather than race into one batch.
        for (const value of DEPOSITS) {
            const r = await alice.deposit({ amount: amt(value), asset: ASSET });
            await awaitOwn(alice, r);
        }
        return { balance: await alice.balance(ASSET) };
    });

    const maxed = once(async () => {
        await deposited();
        return {
            // `kind` is what makes the figure spendable as-is: without it nothing
            // is reserved for the relayer, and a transfer of the answer would
            // need `answer + fee` of cover (`sdk/src/wallet/surface/spend.ts`).
            max: await alice.spendableMax(ASSET, { kind: "transfer" }),
            quoted: await quotedTransferFee(),
        };
    });

    const refusedOverMax = once(async () => {
        const { max } = await maxed();
        const before = await alice.balance(ASSET);
        let raised: unknown;
        try {
            await alice.transfer({
                recipient: bob.address,
                amount: amt(max.max + 1n),
                asset: ASSET,
            });
        } catch (e) {
            raised = e;
        }
        return { max, raised, before, after: await alice.balance(ASSET) };
    });

    const spentMax = once(async () => {
        const { max } = await maxed();
        // Ordered before the spend: the refusal is about the five-note wallet.
        await refusedOverMax();
        const bobBefore = await shieldedBalance(bob, ASSET);
        const r = await alice.transfer({ recipient: bob.address, amount: max.max, asset: ASSET });
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);
        return {
            max,
            bobBefore,
            fee: await expectRelayerPaid(r, ASSET),
            bobAfter: await shieldedBalance(bob, ASSET),
            balance: await alice.balance(ASSET),
        };
    });

    const refusedOverSingleNote = once(async () => {
        const { balance } = await spentMax();
        const max = await alice.spendableMax(ASSET, { kind: "transfer" });
        let raised: unknown;
        try {
            await alice.transfer({
                recipient: bob.address,
                amount: amt(max.max + 1n),
                asset: ASSET,
            });
        } catch (e) {
            raised = e;
        }
        return { balance, max, raised };
    });

    const changeLanded = once(async () => {
        await refusedOverSingleNote();
        const r = await alice.transfer({
            recipient: bob.address,
            amount: COOLDOWN_SEND,
            asset: ASSET,
        });
        // Not `awaitOwn`: it mines two blocks on purpose, so that every other
        // spec's notes are out of the spend cooldown when it returns
        // (`src/wait.ts`). This case is about the cooldown, so the chain is only
        // advanced where the case says so, and the wait is the SDK's own.
        const seen = await alice.awaitCommitments(r.ownCommitments, {
            pageSize: SYNC_LIMIT,
            throwOnTimeout: true,
        });
        expect(seen.missing, "the change reached the note cache").toEqual([]);
        // The next spend proves against the tree, which `"notes"` would not sync.
        await alice.sync({ scope: "full", pageSize: SYNC_LIMIT });
        await awaitRecipient(bob, r);
        const fee = await expectRelayerPaid(r, ASSET);

        const own = new Set(r.ownCommitments.map((c) => c.toLowerCase()));
        const change = (await alice.notes({ asset: ASSET, spent: false })).find(
            (n) => own.has(n.cm.toLowerCase()) && n.value > 0n,
        );
        if (!change || change.firstSeenBlock === undefined) {
            throw new Error("the transfer left no change note carrying a first-seen block");
        }
        // Read after the note, so the window below is never negative.
        const tip = await h.provider.getBlockNumber();
        return {
            fee,
            change,
            balance: await alice.balance(ASSET),
            /** Wide enough to cover the change note's age right now, plus slack. */
            window: tip - change.firstSeenBlock + COOLDOWN_GUARD,
        };
    });

    const cooldownPassed = once(async () => {
        const { window } = await changeLanded();
        // Deterministic in the direction that matters: mining only raises the
        // tip, so after `COOLDOWN_GUARD` blocks every note's age is at least
        // `window` and none of them is inside it any more.
        await mineIfAnvil(h.provider, COOLDOWN_GUARD);
        await alice.sync({ scope: "full", pageSize: SYNC_LIMIT });
        const max = await alice.spendableMax(ASSET, {
            kind: "transfer",
            selection: { cooldownBlocks: window },
        });
        const before = await alice.balance(ASSET);
        const bobBefore = await shieldedBalance(bob, ASSET);
        const r = await alice.transfer({
            recipient: bob.address,
            amount: max.max,
            asset: ASSET,
            selection: { cooldownBlocks: window },
        });
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);
        return {
            max,
            before,
            bobBefore,
            fee: await expectRelayerPaid(r, ASSET),
            bobAfter: await shieldedBalance(bob, ASSET),
            balance: await alice.balance(ASSET),
        };
    });

    it("balance splits the notes into what one spend can reach and what it cannot", async () => {
        const { balance } = await deposited();

        expect(balance.total, "every deposit landed at its face value").toBe(TOTAL);
        expect((await alice.notes({ asset: ASSET, spent: false })).length).toBe(DEPOSITS.length);
        // `balance()` asks `spendableMax` with the circuit's arity and no fee
        // reserved (`sdk/src/wallet/surface/read.ts`), so this is the sum of the
        // four largest notes.
        expect(balance.spendable, `the ${N_IN} largest notes`).toBe(TOP_FOUR);
        // The fifth is spendable in principle and beyond the input slots, which
        // is the one bucket that time never releases: only consolidation does.
        expect(balance.withheld.slots, "the note past the input slots").toBe(BEYOND_SLOTS);
        expect(balance.withheld.reserved, "nothing in flight").toBe(0n);
        // `awaitOwn` mined past the spend cooldown after each deposit, and
        // `balance()` applies no dust threshold.
        expect(balance.withheld.cooldown).toBe(0n);
        expect(balance.withheld.dust).toBe(0n);
        expectBalanceAddsUp(balance);
    }, TEST_TIMEOUT.MANY_DEPOSITS);

    it("spendableMax reserves the relayer's fee, and one unit more has no cover", async () => {
        const { max, quoted } = await maxed();
        const { raised, before, after } = await refusedOverMax();

        // Asked with `kind`, the maximum is the four largest notes less the fee
        // they must also fund (`sdk/src/wallet/selection/spendable-max.ts`).
        expect(TOP_FOUR - max.max, "the fee held back out of the maximum").toBe(quoted);
        expect(max.withheld.slots, "and the fifth note is still out of reach").toBe(BEYOND_SLOTS);

        // One unit over: the cover needed becomes `TOP_FOUR + 1`, which no four
        // of these notes reach, while all five would. That is `INSUFFICIENT_COVER`
        // and not `INSUFFICIENT_BALANCE` — the balance is there, the input slots
        // are not (`sdk/src/errors/funds.ts`, `sdk/src/wallet/tx/cover.ts`).
        if (!isWalletError(raised, "INSUFFICIENT_COVER")) {
            throw new Error(`one unit over the maximum was not refused: ${describeError(raised)}`);
        }
        expect(raised.reason).toBe("arity");
        // `target` is the cover the spend needed, which is the amount plus the
        // same-asset fee (`tx/run-spend.ts` covers both), so it is a unit past
        // everything the four reachable notes hold.
        expect(raised.target, "the cover the spend needed, fee included").toBe(TOP_FOUR + 1n);
        expect(raised.consolidationAttempted, "no `autoConsolidate` was asked for").toBe(false);
        // The hint is the smallest notes the circuit could merge in one spend:
        // 40 + 60 + 80 + 120 (`sdk/src/wallet/selection/sfrt.ts`).
        expect(raised.consolidate.length).toBe(N_IN);
        expect(raised.consolidateSum).toBe(TOTAL - DEPOSITS[4]);

        // A refusal before proving moves nothing.
        expect(after.total, "the refusal spent nothing").toBe(before.total);
        expect(after.withheld.reserved, "and reserved nothing").toBe(0n);
        expectBalanceAddsUp(after);
    }, TEST_TIMEOUT.MANY_DEPOSITS);

    it("a transfer of exactly spendableMax lands, and the remainder is what was withheld", async () => {
        const { max, bobBefore, fee, bobAfter, balance } = await spentMax();

        // The fee actually charged is the one the maximum reserved: if it were
        // not, the amounts below would not close.
        expect(fee, "charged exactly what the maximum held back").toBe(TOP_FOUR - max.max);
        expect(bobAfter - bobBefore, "bob credited the full maximum").toBe(max.max);
        // The four notes are gone, principal and fee both out of them, so what
        // alice keeps is the note the call named as out of reach.
        expect(balance.total, "what is left is exactly what was withheld").toBe(max.withheld.slots);
        expect(balance.total).toBe(BEYOND_SLOTS);
        // With one note left there is nothing beyond the input slots any more.
        expect(balance.withheld.slots).toBe(0n);
        expect(balance.spendable, "and it is spendable").toBe(BEYOND_SLOTS);
        expectBalanceAddsUp(balance);
    }, TEST_TIMEOUT.MANY_DEPOSITS + TEST_TIMEOUT.SPEND);

    it("with one note left, one unit over the maximum is refused as insufficient balance", async () => {
        const { balance, max, raised } = await refusedOverSingleNote();

        expect(balance.total).toBe(BEYOND_SLOTS);
        expect(BEYOND_SLOTS - max.max, "the fee held back out of the one note").toBeGreaterThan(0n);

        // The same "one unit over" as the case above, refused for the other
        // reason: here no note is held back and none is out of slots, so the
        // shortfall is the balance itself and no wait or merge helps
        // (`sdk/src/wallet/selection/spendability.ts` `fundingError`).
        if (!isWalletError(raised, "INSUFFICIENT_BALANCE")) {
            throw new Error(`one unit over the maximum was not refused: ${describeError(raised)}`);
        }
        expect(raised.asset).toBe(ASSET);
        expect(raised.available, "every unspent note of the asset").toBe(BEYOND_SLOTS);
        // `max.max + 1` plus the same fee the maximum reserved: one unit past the
        // whole balance, exactly.
        expect(raised.required, "one unit past the balance").toBe(BEYOND_SLOTS + 1n);
    }, TEST_TIMEOUT.MANY_DEPOSITS + TEST_TIMEOUT.SPEND);

    it("a note inside the spend cooldown is withheld, and no spend can reach it", async () => {
        const { fee, change, balance, window } = await changeLanded();

        // The change is the only value alice has left; the transfer's other
        // outputs to herself, if any, are worth nothing.
        expect(balance.total, "principal and fee both came out of the note").toBe(
            BEYOND_SLOTS - COOLDOWN_SEND - fee,
        );
        expect(change.value).toBe(balance.total);

        const held = await alice.spendableMax(ASSET, {
            kind: "transfer",
            selection: { cooldownBlocks: window },
        });
        // The cooldown is checked as `tip - firstSeenBlock < cooldownBlocks`
        // (`sdk/src/wallet/selection/spendability.ts`), so a window wider than the
        // note's age withholds it whatever the tip has done since.
        expect(held.withheld.cooldown, "the whole balance is cooling down").toBe(balance.total);
        expect(held.max, "so a spend can reach none of it").toBe(0n);

        // And the selector agrees: same rules, so the refusal names the same
        // bucket rather than reporting an empty wallet.
        let raised: unknown;
        try {
            await alice.transfer({
                recipient: bob.address,
                amount: amt(1n),
                asset: ASSET,
                selection: { cooldownBlocks: window },
            });
        } catch (e) {
            raised = e;
        }
        if (!isWalletError(raised, "NOTES_HELD")) {
            throw new Error(`a cooling-down note was not held back: ${describeError(raised)}`);
        }
        expect(raised.spendable, "nothing the selector was free to use").toBe(0n);
        expect(raised.held.cooldown.value).toBe(balance.total);
        expect(raised.held.reserved.value).toBe(0n);
        expect(raised.held.dust.value).toBe(0n);
        // Blocks alone fix it, which is what the next case does.
        expect(raised.retryable, "released by waiting").toBe(true);
    }, TEST_TIMEOUT.MANY_DEPOSITS + 2 * TEST_TIMEOUT.SPEND);

    it("mining past the cooldown releases the note and it spends", async () => {
        const { balance: heldBalance } = await changeLanded();
        const { max, before, bobBefore, fee, bobAfter, balance } = await cooldownPassed();

        // Same window, same note, `COOLDOWN_GUARD` blocks later.
        expect(before.total, "nothing changed but the tip").toBe(heldBalance.total);
        expect(max.withheld.cooldown, "no longer cooling down").toBe(0n);
        expect(before.total - max.max, "the fee held back out of it").toBe(fee);

        expect(bobAfter - bobBefore, "bob credited the full maximum").toBe(max.max);
        expect(balance.total, "alice spent the note down to nothing").toBe(0n);
        expectBalanceAddsUp(balance);
    }, TEST_TIMEOUT.MANY_DEPOSITS + 3 * TEST_TIMEOUT.SPEND);
});
