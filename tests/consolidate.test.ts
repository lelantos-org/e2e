// A balance spread over more notes than the circuit has input slots.
//
// The transact circuit is 4-in/6-out (`N_IN`/`N_OUT`, pinned in
// `src/protocol/shape.ts`), so one spend reaches at most four notes however many
// the wallet holds. A wallet with six equal notes therefore has a balance it
// cannot spend in one go, and the SDK has two answers for it:
//
//   * refuse, naming the notes to merge — `INSUFFICIENT_COVER` with a
//     `consolidate` hint (`sdk/src/wallet/tx/cover.ts:96-105`);
//   * merge them itself when the caller passes `autoConsolidate: true` — a
//     pinned self-spend of the smallest `N_IN` notes, then a retry
//     (`sdk/src/wallet/ops/consolidate.ts`).
//
// Neither is reachable from a unit test: the merge is a real spend that has to
// be proven, relayed, indexed and aged past the selector's spend cooldown before
// the retry can see it, and the SDK's own tests stub the transfer out.
//
// What the cases pin, and the drift they catch:
//
//   * the refusal is `INSUFFICIENT_COVER` and not `INSUFFICIENT_BALANCE`: the
//     money is there, the slots are not. A selector that reported the wrong one
//     would send applications to a top-up flow that cannot help.
//   * the refusal carries the merge plan — `N_IN` note ids and their sum — and
//     spends nothing. An error that named no notes leaves a caller with no
//     recovery, and one that spent first would burn a fee on a refusal.
//   * with `autoConsolidate`, the transfer lands and every unit is accounted
//     for: bob is credited exactly, and alice is down exactly the transfer plus
//     the relayer fee of *both* spends.
//   * the merge is a real merge: a note worth the merged sum was created and
//     consumed, and alice holds fewer notes than she started with.
//
// Deposits go through the direct `buildDeposit` path rather than
// `wallet.deposit`, for wall clock: six wallet deposits are six serial flush
// waits, while six direct submits fire in parallel and the relayer drains them
// in two batches (`flush_max_n = 4`, `config/relayer.toml`). The notes are the
// same notes — they are addressed to alice's own recipient, so her SDK wallet
// recovers them on the next sync.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import {
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    buildDirectDeposit,
    type CircuitWallet,
    cmToHex,
    counter,
    expectRelayerPaid,
    expectRevert,
    type Harness,
    isWalletError,
    makeWallet,
    mineIfAnvil,
    newAuxRng,
    N_IN,
    N_OUT,
    quoteDepositFee,
    relayerFeeNote,
    relayerFeeWallet,
    shieldedBalance,
    submitDepositDirect,
    syncedBalance,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { POLL } from "../src/testkit/timeouts.js";

const { alice: ALICE_NSK } = TEST_NSK.consolidate;

/** Notes alice is given, all of the same value: two more than the circuit takes. */
const NOTES = 6;
/** One deposit, in circuit units. */
const NOTE = amt(20n);
const TOTAL = amt(BigInt(NOTES) * NOTE);
/** The most any single spend can reach before a merge: every note is worth the same. */
const REACHABLE = BigInt(N_IN) * NOTE;

/**
 * The transfer, chosen so the answer is the same whatever the relayer charges.
 *
 * The relayer prices a spend off live gas and this stack's oracle stub lands it
 * at one to three circuit units (`config/oracle/README.md`), so the amount is
 * picked to bracket that whole band:
 *
 *   * above `REACHABLE` (80) even at the smallest fee, so no four notes cover
 *     `amount + fee` and the selector must ask for a merge;
 *   * below what remains after the merge (`5 · NOTE - 1 = 99`) even at the
 *     largest, so the retry is a plain two-input spend.
 */
const TO_BOB = amt(88n);

/**
 * The merge's own cost is read, not assumed.
 *
 * The merge runs inside `transfer` and its `TransferResult` never reaches the
 * caller, so the only place its fee shows up is the relayer's own shielded
 * balance: what the relayer gained, less what the retry's result says it
 * charged, is what the merge paid. Deriving it keeps this file correct across a
 * change to how the merge sizes itself — `ops/consolidate.ts` currently sends
 * `consolidateSum - 1` regardless of the fee, which is being made fee-aware.
 */

describe("spending a balance spread over more notes than the circuit's inputs", () => {
    let h: Harness;
    let alice: SdkWallet;
    let bob: SdkWallet;
    /** The raw key bundle behind `alice`, for the direct deposit path. */
    let aliceKeys: CircuitWallet;
    // Seeds unique to this file and far apart: every file draws clues and
    // ephemerals onto one shared anvil and one shared FMD index.
    const rng = counter(0x53_a1ce_0001n);
    const auxRng = newAuxRng(0x53_add_0001n);

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.consolidate,
            // `fundPayerForAsset` adds the relayer-fee headroom on top, which is
            // what pays the `NOTES` deposit fee notes.
            fund: [{ asset: ASSET, amount: withFee(TOTAL) }],
        });
        ({ h } = f);
        ({ alice, bob } = f.w);
        aliceKeys = makeWallet(h.P, h.J, ALICE_NSK);
    });

    /** The relayer's spendable holdings in `ASSET`, as its own wallet reads them. */
    async function relayerHolding(): Promise<bigint> {
        const w = await relayerFeeWallet();
        await w.sync({ pageSize: SYNC_LIMIT });
        return shieldedBalance(w, ASSET);
    }

    /**
     * Give alice `NOTES` notes of `NOTE` each.
     *
     * Every witness is built before any is submitted: both leaves of a deposit
     * draw from the shared counters in a fixed order, so interleaving builds
     * makes reruns diverge. The submits then fire in parallel under one
     * `NonceManager`, so the relayer sees all six pending at once.
     */
    const funded = once(async () => {
        // One quote prices every deposit: the charge is per-deposit and asking
        // once keeps all six identical. A relayer charging nothing would flush
        // anything, including a deposit whose fee note pays no one.
        const feeValue = await quoteDepositFee(h.relayer, env.chainId, ASSET);
        expect(feeValue, "relayer must charge for a flush").toBeGreaterThan(0n);

        const builts = Array.from({ length: NOTES }, () =>
            buildDirectDeposit(h, {
                amount: NOTE,
                recipient: aliceKeys.recipient,
                rngs: { rng, auxRng },
                // Pays this relayer, so the deposits actually flush; a note
                // addressed elsewhere is skipped for ever.
                fee: (r) => relayerFeeNote(h.J, feeValue, r),
            }),
        );
        const noncedPayer = new ethers.NonceManager(h.payer);
        await Promise.all(builts.map((b) => submitDepositDirect(h, b, { payer: noncedPayer })));

        // The deposits are addressed to alice's own recipient, so her wallet
        // recovers them by scanning. Waiting on the commitments rather than on
        // the flush events: a flushed leaf the indexer has not surfaced is not
        // yet a note she can spend.
        const cms = builts.map((b) => cmToHex(b.cm));
        const seen = await alice.awaitCommitments(cms, {
            pageSize: SYNC_LIMIT,
            pollMs: POLL.COMMITMENT.pollMs,
            timeoutMs: POLL.COMMITMENT.timeoutMs,
        });
        expect(seen.status, `deposits not indexed: ${seen.missing.join(", ")}`).toBe("seen");
        // A spend proves against the wallet's own folded tree, which
        // `awaitCommitments` does not sync.
        await alice.sync({ scope: "full", pageSize: SYNC_LIMIT });
        // The selector will not spend a note until the tip has moved past the
        // block it was first seen in (`DEFAULT_COOLDOWN_BLOCKS`).
        await mineIfAnvil(h.provider, 2);
    });

    /**
     * The same transfer without `autoConsolidate`: the refusal, and the phases
     * it emitted on the way.
     *
     * Memoised so both cases below read one attempt, and so it runs before the
     * consolidating one, which changes the note set it is about.
     */
    const refused = once(async () => {
        await funded();
        const phases: string[] = [];
        const err = await expectRevert(
            alice.transfer({
                recipient: bob.address,
                amount: TO_BOB,
                asset: ASSET,
                onPhase: (phase) => {
                    phases.push(phase);
                },
            }),
            { code: "INSUFFICIENT_COVER" },
        );
        // `expectRevert` already checked the code; this narrows the error to the
        // class carrying the merge plan without a cast.
        if (!isWalletError(err, "INSUFFICIENT_COVER")) throw err;
        return { err, phases };
    });

    /**
     * The same transfer with `autoConsolidate: true`, and everything the
     * assertions read about it.
     *
     * Settled rather than succeeded on the refusal: it spends nothing whether it
     * refused or not, and its own cases report a failure.
     */
    const consolidated = once(async () => {
        await refused().catch(() => undefined);
        const notesBefore = await alice.notes({ asset: ASSET, spent: false });
        const relayerBefore = await relayerHolding();

        const phases: string[] = [];
        const r = await alice.transfer({
            recipient: bob.address,
            amount: TO_BOB,
            asset: ASSET,
            autoConsolidate: true,
            onPhase: (phase) => {
                phases.push(phase);
            },
        });
        // Asserts the note is the relayer's, in `ASSET`, for what the result
        // says it charged. Only the retry's fee: the merge's own spend result is
        // internal to `transfer`.
        const fee = await expectRelayerPaid(r, ASSET);
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);

        return {
            r,
            fee,
            phases,
            notesBefore,
            relayerBefore,
            notesAfter: await alice.notes({ asset: ASSET, spent: false }),
            spentNotes: await alice.notes({ asset: ASSET, spent: true }),
            relayerAfter: await relayerHolding(),
        };
    });

    it("six deposits leave alice more notes than one spend can reach", async () => {
        await funded();
        expect(NOTES, "the point of the file: more notes than input slots").toBeGreaterThan(N_IN);
        expect(await shieldedBalance(alice, ASSET)).toBe(TOTAL);
        const notes = await alice.notes({ asset: ASSET, spent: false });
        expect(notes).toHaveLength(NOTES);
        expect(notes.map((n) => n.value)).toEqual(Array.from({ length: NOTES }, () => NOTE));
    }, TEST_TIMEOUT.MANY_DEPOSITS);

    it("refuses a transfer needing more than the circuit's inputs, naming the notes to merge", async () => {
        const { err } = await refused();
        expect(err.asset).toBe(ASSET);
        // Not "the balance is short": every unit is there, and topping up would
        // add a seventh note rather than help.
        expect(err.reason, "the slots ran out, not the funds").toBe("arity");
        expect(err.consolidationAttempted, "no merge was asked for, so none ran").toBe(false);

        // The merge plan: the smallest `N_IN` notes, which with equal notes is
        // also the most valuable four, so `consolidateSum` is the ceiling on what
        // any single spend could have covered.
        expect(err.consolidate).toHaveLength(N_IN);
        expect(err.consolidate.map((c) => BigInt(c.value))).toEqual(
            Array.from({ length: N_IN }, () => NOTE),
        );
        expect(err.consolidateSum).toBe(REACHABLE);
        // `target` is the transfer plus the same-asset relayer fee covered on
        // top of it, so it is above the amount and above what four notes reach.
        expect(err.target, "the fee is covered alongside the amount").toBeGreaterThan(TO_BOB);
        expect(err.consolidateSum, "no four notes cover the target").toBeLessThan(err.target);
        // Every id is one alice actually holds, or the recovery it describes
        // cannot be carried out.
        const held = new Set((await alice.notes({ asset: ASSET, spent: false })).map((n) => n.id));
        for (const hint of err.consolidate) expect(held.has(hint.id)).toBe(true);
    }, TEST_TIMEOUT.MANY_DEPOSITS);

    it("spends nothing when it refuses", async () => {
        const { phases } = await refused();
        // The refusal is raised while selecting, before anything is proven or
        // submitted, so no fee was burned and no note was consumed.
        expect(phases, "no merge without autoConsolidate").not.toContain("consolidating");
        expect(phases).not.toContain("submitting");
        // Synced rather than cached: a claim that nothing left the wallet must
        // read the chain, not the note cache the refusal never touched.
        expect(await syncedBalance(alice, ASSET)).toBe(TOTAL);
        expect(await alice.notes({ asset: ASSET, spent: false })).toHaveLength(NOTES);
    }, TEST_TIMEOUT.MANY_DEPOSITS);

    it("merges and lands the transfer with autoConsolidate, crediting bob exactly", async () => {
        const { r, fee, phases, relayerBefore, relayerAfter } = await consolidated();
        expect(phases, "the merge ran under the transfer's own operation").toContain("consolidating");
        expect(r.amount.amount).toBe(TO_BOB);
        expect(r.commitments, "one output per circuit slot").toHaveLength(N_OUT);
        // Synced: bob's wallet must not be able to report a credit its cache
        // merely happens to hold.
        expect(await syncedBalance(bob, ASSET), "credited the transfer, nothing else").toBe(TO_BOB);

        // Two spends were relayed, and the relayer was paid for both: the retry
        // reports its own fee, and the merge's shows up only here.
        const relayed = relayerAfter - relayerBefore;
        expect(relayed - fee, "the merge paid a fee of its own").toBeGreaterThan(0n);
        // Every unit accounted for: what alice no longer has is bob's note plus
        // both fees, and nothing else.
        expect(await shieldedBalance(alice, ASSET)).toBe(TOTAL - TO_BOB - relayed);
    }, TEST_TIMEOUT.MANY_DEPOSITS);

    it("leaves behind the merged note and fewer notes than it started with", async () => {
        const { notesBefore, notesAfter, spentNotes, fee, relayerBefore, relayerAfter } =
            await consolidated();
        const mergeFee = relayerAfter - relayerBefore - fee;
        // The merge folded all four reachable notes into one addressed to alice
        // herself, which the retry then consumed — the only way the retry had
        // cover.
        const spentBelowSum = spentNotes.filter((n) => n.value > NOTE && n.value < REACHABLE);
        expect(spentBelowSum, "one merged note, spent by the retry").toHaveLength(1);
        // `autoConsolidate` sends what the pinned notes can cover after their
        // own fee, keeping a one-unit change note (`ops/consolidate.ts`), so
        // the merged note is the reachable sum less that fee and that unit.
        expect(spentBelowSum[0].value, "the merged sum, less the merge's fee and its change")
            .toBe(REACHABLE - mergeFee - 1n);
        // Weaker than the balance assertion above, and deliberately so: the
        // retry's change is split across the free output slots, so the exact
        // count depends on the split rather than on the merge.
        expect(notesBefore).toHaveLength(NOTES);
        expect(notesAfter.length, "the merge left fewer notes").toBeLessThan(notesBefore.length);
    }, TEST_TIMEOUT.MANY_DEPOSITS);
});
