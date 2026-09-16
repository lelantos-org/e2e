// What a resubmitted spend costs, and what an unanswered one leaves behind.
//
// A submit is the one request in the suite that is not safe to repeat blindly:
// it moves money, and the client learns whether it did only from a response it
// may never receive. The SDK's answer is one client-generated `Idempotency-Key`
// for every attempt of a logical submit (`sdk/src/services/http/client.ts`), and
// the relayer's is a keyed, spawned run whose answer is cached and replayed
// (`backend/crates/relayer/src/services/admission/idempotency.rs`). Two
// properties fall out, and neither is observable from either side alone:
//
//   * a submit retried under one key lands exactly once — the relayer holds one
//     operation however many HTTP attempts were made, and the recipient is
//     credited once;
//   * a submit the client never gets an answer to leaves its inputs *reserved*
//     rather than spent, so the wallet neither loses the notes nor offers them
//     to a second spend that the pool would refuse as a double spend.
//
// Both are staged with the relayer's batcher held: a hold keeps a submit open
// for as long as the test needs, which is what turns "the client gave up before
// the relayer answered" from a race into something a test can arrange. The
// wallets here are built with a deliberately short per-attempt `submitTimeoutMs`
// so the SDK's own retry policy fires — a submit retries only where the relayer
// cannot have acted (no response, 429, 503; `SUBMIT_RETRY_STATUS` in
// `client.ts`), so a timed-out attempt, which is what a held batcher produces,
// is the honest way to force one. Answering an attempt with a synthetic 503
// through `captureSubmits({ onSubmit })` would also retry, but it would prove
// only that the transport resends: the relayer would never have taken the
// operation, so the "exactly one queued operation" property would be vacuous.
//
// A hold is chain-wide and outlives the test that set it, so every case
// releases in a `finally` and `afterEach` releases again.

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { TransferResult } from "@lelantos-org/sdk";

import { env } from "../../src/env.js";
import {
    amt,
    ASSET,
    awaitBalance,
    awaitOwn,
    awaitRecipient,
    asSubmit,
    type CapturedRequest,
    captureSubmits,
    createTestWallet,
    expectRelayerPaid,
    expectRevert,
    FEE_HEADROOM,
    type Harness,
    type QueuedOp,
    RelayerHooks,
    replay,
    shieldedBalance,
    spendItem,
    submitBody,
    type SubmitCapture,
    syncedBalance,
    tampered,
    TEST_NSK,
    TEST_TIMEOUT,
    txBundleItems,
    withFee,
} from "../../src/harness.js";
import { once, setupFile, type SdkWallet } from "../../src/fixture.js";
import { TIMEOUT } from "../../src/testkit/timeouts.js";
import { pollUntil } from "../../src/utils.js";

const NSK = TEST_NSK.submitRetry;

/**
 * Keys for the unknown-outcome case, kept out of `TEST_NSK.submitRetry`.
 *
 * That case deliberately leaves a wallet holding a reserved note for the length
 * of the hold, and reusing the retry case's alice would mean her balance
 * depended on which `it` ran first. Prefix `0x5a` is used by no `TEST_NSK` entry
 * and by no other file's local prefix (`0xec` in `edge/concurrent-spends`);
 * files share one FMD index, so a colliding key leaks notes across tests.
 */
const UNKNOWN_NSK = { carol: 0x5a_ca10_ca100n, dora: 0x5a_d024_d0240n } as const;

/** Each case's one deposit, in circuit units. */
const DEPOSIT = 40n;
/** Below the deposit: a spend also funds the note that pays the relayer. */
const SEND = 10n;

/**
 * Per-attempt deadline for a submit, in ms.
 *
 * Long enough that the relayer has admitted the operation and queued it behind
 * the hold before the first attempt is abandoned — admission is proof
 * verification, a fee check and a DB read, with no chain round trip
 * (`pipeline/spend/mod.rs`) — and far below the relayer's own 180s request
 * deadline (`REQUEST_TIMEOUT` in `handlers/http/router.rs`), so the client gives
 * up first and the relayer's run keeps going. That is the case these tests are
 * about; an attempt that outlived the relayer's deadline would be answered 503
 * instead and exercise a different branch of the retry policy.
 */
const ATTEMPT_MS = 10_000;

/**
 * Retries for the retry case: enough that the hold can be released while the
 * SDK is still resending, with headroom for a slow attempt rather than a budget
 * the case is expected to use up. The hold is released as soon as the second
 * attempt is on the wire, which is one backoff after the first deadline.
 */
const RETRIES = 5;

/**
 * Attempts for the unknown-outcome case, including the first.
 *
 * Here the whole budget is meant to be spent while the batcher is held, so it is
 * kept small: three attempts at `ATTEMPT_MS` plus the SDK's 250ms/500ms backoffs
 * is about 31s of held window.
 */
const UNKNOWN_ATTEMPTS = 3;

/** A submit's nullifiers as canonical decimal strings, for comparison with `QueuedOp`. */
function nullifiersOf(req: CapturedRequest): Set<string> {
    return new Set(submitBody(req).pubInputs.nullifier.map((nf) => BigInt(nf).toString()));
}

describe("edge: idempotent submit and unknown outcome", () => {
    let h: Harness;
    let alice: SdkWallet;
    let bob: SdkWallet;
    let hooks: RelayerHooks;

    beforeAll(async () => {
        ({ h, w: { bob } } = await setupFile({
            // Only bob comes from the fixture: alice needs the capturing
            // transport and the short submit deadline, which `setupFile` does
            // not pass through.
            nsks: { bob: NSK.bob },
            // Two deposits, one per case, each with room for its relayer fee.
            fund: [{ asset: ASSET, amount: withFee(2n * (DEPOSIT + FEE_HEADROOM)) }],
        }));
        hooks = new RelayerHooks(env.relayerUrl, env.chainId);
        // A hold left by an earlier run against a kept-alive stack would stall
        // the funding deposits below.
        await hooks.release();
    });

    afterEach(async () => {
        await hooks.release();
    });

    /**
     * Wait until `capture` has made at least `want` attempts and exactly one
     * operation is queued, failing early if the spend settles first.
     *
     * A spend that settles while the batcher is held means it was never held —
     * so the queue it was supposed to fill was never observed — and waiting out
     * the poll would only report that as a timeout.
     */
    async function heldUntilRetried(
        pending: Promise<unknown>,
        capture: SubmitCapture,
        want: number,
    ): Promise<QueuedOp[]> {
        const early = pending.then(
            () => {
                throw new Error("the spend settled while the batcher was held");
            },
            (e: unknown) => {
                throw new Error("the spend failed before it could be retried", { cause: e });
            },
        );
        early.catch(() => undefined);
        const poll = pollUntil(
            async () => {
                if (capture.requests.length < want) return null;
                const ops = await hooks.queue();
                return ops.length > 0 ? ops : null;
            },
            { label: `${want} submit attempts with the operation queued`, timeoutMs: TIMEOUT.POLL_DEFAULT_MS, intervalMs: 250 },
        );
        return Promise.race([poll, early]);
    }

    /**
     * The retry case, as a stage: the key-reuse case replays the request it
     * captured, and the relayer remembers an answered key for 15 minutes
     * (`TTL` in `admission/idempotency.rs`), so that case is ordered
     * immediately after this one rather than after the slower unknown-outcome
     * case.
     */
    const retried = once(async () => {
        const capture = captureSubmits();
        alice = await createTestWallet(NSK.alice, {
            submitTimeoutMs: ATTEMPT_MS,
            retries: RETRIES,
            fetch: capture.fetch,
        });
        const d = await alice.deposit({ amount: amt(DEPOSIT), asset: ASSET });
        await awaitOwn(alice, d);
        // The deposit reaches the pool through the chain adapter and the fee
        // estimate is an idempotent POST, so neither is a submit: nothing has
        // been captured yet.
        expect(capture.requests.length, "a deposit makes no submit").toBe(0);

        await hooks.hold();
        let r: TransferResult;
        let queued: QueuedOp[];
        try {
            const pending = alice.transfer({ recipient: bob.address, amount: amt(SEND), asset: ASSET });
            // The first attempt is abandoned after `ATTEMPT_MS`; the second goes
            // out one backoff later, under the same key, and joins the run the
            // first one started.
            queued = await heldUntilRetried(pending, capture, 2);
            await hooks.release();
            r = await pending;
        } finally {
            await hooks.release();
        }
        return { r, capture, queued };
    });

    it("a submit retried under one idempotency key queues one operation and lands once", async () => {
        const { r, capture, queued } = await retried();

        // Several attempts, one key: the relayer can recognise the repeat, so
        // the retries are resends of one logical submit rather than new ones.
        expect(capture.requests.length, "the SDK retried the held submit").toBeGreaterThanOrEqual(2);
        const keys = new Set(capture.requests.map((req) => req.idempotencyKey));
        expect(keys.size, "every attempt carried the same Idempotency-Key").toBe(1);
        expect([...keys][0], "a submit always carries one").toBeTypeOf("string");

        // The property: however many attempts were made, the relayer took the
        // operation once. `queue()` is a live view only while the batcher is
        // held, which it was when this was read.
        expect(queued.length, "the retries did not enqueue a second operation").toBe(1);
        expect(queued[0].kind).toBe("transfer");
        const submitted = nullifiersOf(capture.requests[0]);
        expect(queued[0].nullifiers.length, "a spend queues with its nullifiers").toBeGreaterThan(0);
        expect(
            queued[0].nullifiers.every((nf) => submitted.has(BigInt(nf).toString())),
            `the queued operation is this submit's: ${queued[0].nullifiers.join(", ")}`,
        ).toBe(true);

        // And it landed once. Counted by nullifier rather than by position,
        // because the transfer shares its transaction with whatever the relayer
        // bundled alongside it.
        const { items } = await txBundleItems(h.provider, r.txHash);
        const ours = items.filter((i) => i.nullifiers.some((nf) => submitted.has(BigInt(nf).toString())));
        expect(ours.length, "one operation on chain carries these nullifiers").toBe(1);
        expect((await spendItem(h.provider, r)).kind).toBe("transfer");

        await awaitRecipient(bob, r);
        await awaitOwn(alice, r);
        expect(await syncedBalance(bob, ASSET), "credited exactly once").toBe(SEND);
        // One landed spend, so one fee note: a second copy would have built a
        // second one, and `expectRelayerPaid` fails if the relayer's keys open
        // more than one commitment from this transaction.
        const fee = await expectRelayerPaid(r, ASSET);
        expect(await shieldedBalance(alice, ASSET), "the note was spent once").toBe(DEPOSIT - SEND - fee);
    }, TEST_TIMEOUT.SEQUENCE);

    it("refuses the same idempotency key over a different submission", async () => {
        const { capture } = await retried();
        const req = capture.last();

        // The relayer's replay check is a fingerprint over the parsed
        // nullifiers and output commitments, not over the request bytes
        // (`submission_fingerprint`, `handlers/http/submit.rs`), so a body that
        // differs only in its proof or its encoding is the *same* submission and
        // replays the first answer. Changing a nullifier is what makes this a
        // different one. It stays a canonical field element, because a
        // non-canonical one is refused with 400 before the key is ever looked up.
        const body = tampered(req, (b) => {
            asSubmit(b).pubInputs.nullifier[0] = "1";
        });
        expect(body, "the tamper changed the body").not.toBe(req.body);

        await hooks.hold();
        try {
            const before = await hooks.queue();
            const res = await replay(req, { body });
            expect(res.status, "a reused key over a different submission is a conflict").toBe(409);
            // Plain text, not JSON: the relayer renders `(status,
            // client_message)` (`domain/error.rs`), and the prefix is
            // `AppError::IdempotencyKeyReused`'s Display. The same string is
            // pinned SDK-side as `idempotency-key-reused` in
            // `sdk/src/services/relayer/reject-reason.ts`.
            expect(await res.text()).toMatch(/^idempotency key reused: /);
            expect(await hooks.queue(), "the refused replay enqueued nothing").toEqual(before);
        } finally {
            await hooks.release();
        }
    }, TEST_TIMEOUT.SEQUENCE);

    it("reserves rather than spends the inputs of a submit it never gets an answer to", async () => {
        const capture = captureSubmits();
        const carol = await createTestWallet(UNKNOWN_NSK.carol, {
            submitTimeoutMs: ATTEMPT_MS,
            retries: UNKNOWN_ATTEMPTS - 1,
            fetch: capture.fetch,
        });
        const dora = await createTestWallet(UNKNOWN_NSK.dora);
        const d = await carol.deposit({ amount: amt(DEPOSIT), asset: ASSET });
        await awaitOwn(carol, d);
        const inputCm = d.escrow.commitment.toLowerCase();

        await hooks.hold();
        try {
            // Every attempt is abandoned while the relayer is still holding the
            // operation, so the client exhausts its budget having learned
            // nothing. The relayer's run is spawned rather than tied to the
            // connection, so the operation it admitted on the first attempt
            // stays queued after the client hangs up.
            await expectRevert(
                carol.transfer({ recipient: dora.address, amount: amt(SEND), asset: ASSET }),
                { code: "SPEND_OUTCOME_UNKNOWN" },
            );
            expect(capture.requests.length, "the whole retry budget was spent").toBe(UNKNOWN_ATTEMPTS);
            expect(
                new Set(capture.requests.map((req) => req.idempotencyKey)).size,
                "under one key, so the relayer folded them into one run",
            ).toBe(1);

            // The relayer did take it: this is what separates "unknown outcome"
            // from "definitely refused".
            const queued = await hooks.queue();
            expect(queued.length, "one operation, from the first attempt").toBe(1);
            expect(queued[0].kind).toBe("transfer");

            // The property. The note is neither spent (the wallet does not know
            // that) nor offered to the next spend (it may already have landed).
            const held = (await carol.notes()).find((n) => n.cm.toLowerCase() === inputCm);
            expect(held, "the deposited note is still in the cache").toBeDefined();
            expect(held?.spent, "an unknown outcome must not mark the inputs spent").toBe(false);
            const balance = await carol.balance(ASSET);
            expect(balance.total, "it still counts toward the balance").toBe(DEPOSIT);
            expect(balance.withheld.reserved, "withheld from selection until the chain resolves it").toBe(DEPOSIT);
            expect(balance.spendable, "so nothing is spendable").toBe(0n);
        } finally {
            await hooks.release();
        }

        // Released: the operation the client lost track of still lands, once.
        // Waited on dora's side, because carol was never handed a result and so
        // has no commitments to await.
        expect(
            await awaitBalance(dora, ASSET, { timeoutMs: TIMEOUT.POLL_DEFAULT_MS }),
            "credited exactly once, by the operation the client abandoned",
        ).toBe(SEND);

        // And carol reconciles: the nullifier feed shows the input spent, which
        // resolves the reservation rather than waiting it out.
        const total = await syncedBalance(carol, ASSET);
        const settled = await carol.balance(ASSET);
        expect(settled.withheld.reserved, "the reservation clears").toBe(0n);
        const spentInput = (await carol.notes()).find((n) => n.cm.toLowerCase() === inputCm);
        expect(spentInput?.spent, "the input is now known spent").toBe(true);
        const change = (await carol.notes()).filter((n) => !n.spent && n.value > 0n);
        expect(change.length, "one change note is left").toBe(1);
        expect(total, "and it is the whole balance").toBe(change[0].value);
        // `publicIn` and `publicOut` are zero for a transfer, so the input note
        // is split between dora's note, carol's change and the relayer's fee
        // note; the first two are pinned exactly above. The fee itself cannot be
        // pinned with `expectRelayerPaid`, which reads `fees.relayer` off a
        // `TransactionResult` the client never received — see the report note on
        // `expectRelayerPaidOnCommitment`.
        expect(DEPOSIT - SEND - total, "the relayer was paid out of the spend").toBeGreaterThan(0n);
    }, TEST_TIMEOUT.SEQUENCE);
});
