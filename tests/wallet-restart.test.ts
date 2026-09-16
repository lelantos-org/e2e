// A wallet rebuilt on the same storage is a restart, not a rescan.
//
// Every other spec gives each wallet its own in-memory stores, so a second
// wallet on one key is a cold client (`full-flow`'s "client sync" case). This
// one hands the same three backends — notes, tree and spent set — to a disposed
// wallet and to its successor, which is what `ConnectStorage` exists for, and
// pins the two properties that follow:
//
//   * the successor starts from what the first one had, without re-reading the
//     feeds, and can spend against the tree it inherited;
//   * a spend whose outcome the first one never learned is still unresolved
//     after the restart, and settles when the chain says what happened.
//
// The second property is the money-safety one. A lease is in memory only
// (`sdk/src/wallet/notes/leases.ts`), so the only thing that can carry an
// unknown outcome across a restart is the persisted `pendingSpendAt` stamp on
// each note (`sdk/src/protocol/note-record.ts`).

import { beforeAll, describe, expect, it } from "vitest";

import type { Balance, ConnectStorage } from "@lelantos-org/sdk";
import {
    InMemoryNoteStore,
    type NullifierPersistence,
    type NullifierStoreState,
    type TreePersistence,
    type TreeStoreState,
} from "@lelantos-org/sdk/advanced";

import {
    amt,
    ASSET,
    awaitBalance,
    awaitOwn,
    awaitRecipient,
    captureSubmits,
    createTestWallet,
    errorText,
    expectRelayerPaid,
    isWalletError,
    replay,
    shieldedBalance,
    SYNC_LIMIT,
    syncedBalance,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const { alice: ALICE_NSK, bob: BOB_NSK } = TEST_NSK.walletRestart;

// One deposit funds the whole narrative: three transfers come out of it, each
// also paying the relayer out of alice's own inputs.
const DEPOSIT = amt(200n);
const BEFORE_RESTART = amt(60n);
const AFTER_RESTART = amt(40n);
const UNKNOWN_OUTCOME = amt(30n);

/**
 * Tree state kept exactly as the SDK hands it over.
 *
 * `TreeStoreState.leaves` (and the memoised `nodes`) carry `bigint`s, which is
 * why `TreePersistence` documents a `0x`-hex encoding for a JSON backend
 * (`sdk/src/sync/tree-store.ts`). An in-memory backend needs no encoding at all
 * — it holds the values as they are, as a structured-clone backend (IndexedDB)
 * would — so this is the smallest thing that satisfies the interface.
 *
 * The arrays are copied on the way in: `TreeStore` keeps folding into its live
 * tree after the save, and a snapshot sharing those arrays would not be a
 * snapshot.
 */
class MemoryTreePersistence implements TreePersistence {
    private state: TreeStoreState | null = null;
    /** Successful saves, so a test can say the backend was actually written. */
    saves = 0;

    async load(): Promise<TreeStoreState | null> {
        return this.state;
    }

    async save(state: TreeStoreState): Promise<void> {
        this.state = {
            leaves: [...state.leaves],
            syncedCount: state.syncedCount,
            nodes: state.nodes ? [...state.nodes] : undefined,
        };
        this.saves++;
    }

    async clear(): Promise<void> {
        // Required by the interface because `TreeStore.reset` depends on it: a
        // backend that ignored `clear` would restore, on the next start, the
        // tree the reset had just discarded as diverged.
        this.state = null;
    }
}

/** The spent set, same shape of backend. `NullifierPersistence` has no `clear`. */
class MemoryNullifierPersistence implements NullifierPersistence {
    private state: NullifierStoreState | null = null;
    saves = 0;

    async load(): Promise<NullifierStoreState | null> {
        return this.state;
    }

    async save(state: NullifierStoreState): Promise<void> {
        this.state = { nullifiers: [...state.nullifiers], syncedCount: state.syncedCount };
        this.saves++;
    }
}

const describeError = (e: unknown): string => (e instanceof Error ? errorText(e) : String(e));

/**
 * `Balance`'s documented split: `total === spendable + withheld.reserved +
 * withheld.cooldown + withheld.dust + withheld.slots`
 * (`sdk/src/wallet/types/sync.ts`).
 *
 * Asserted wherever this file reads a balance, because the unknown-outcome case
 * moves the whole balance from `spendable` into `withheld.reserved` and back
 * again: a bucket that leaked value would show up here first.
 */
function expectBalanceAddsUp(b: Balance): void {
    const { reserved, cooldown, dust, slots } = b.withheld;
    expect(b.spendable + reserved + cooldown + dust + slots, "balance split adds up").toBe(b.total);
}

describe("wallet restart on persisted storage", () => {
    let alice: SdkWallet;
    let bob: SdkWallet;

    // One set of backends for every generation of alice. Passing the same three
    // objects to the next `connect` is the whole mechanism under test.
    const notes = new InMemoryNoteStore();
    const tree = new MemoryTreePersistence();
    const nullifiers = new MemoryNullifierPersistence();
    const storage: ConnectStorage = { notes, tree, nullifiers };

    /** Set for the one spend whose answer the wallet must never see. */
    let dropTheAnswer = false;
    /** The forwarded copy of that spend; held only so its rejection is handled. */
    let forwarded: Promise<Response> | undefined;

    const capture = captureSubmits({
        onSubmit: async (req) => {
            // Every other submit goes to the relayer untouched.
            if (!dropTheAnswer) return;
            // The relayer runs a submission on a spawned task and keeps its
            // nullifier reservation "even if this caller hangs up"
            // (`backend/crates/relayer/src/handlers/http/submit.rs:88-96`), so
            // forwarding the captured request verbatim — same body, same
            // `Idempotency-Key`, and the only copy that reaches the relayer —
            // lands the spend, while failing this attempt leaves the wallet with
            // no answer. A throw is what a dropped connection looks like to the
            // SDK transport: a `NetworkError` carrying no status, which
            // `outcomeUnknown` (`sdk/src/wallet/tx/steps.ts:45-50`) reads as
            // "this may have been acted on".
            forwarded = replay(req);
            // Its answer is never read. `replay` gives up after `TIMEOUT.HTTP_MS`
            // and the operation outlives that; swallowing keeps an abandoned
            // request from surfacing as an unhandled rejection. That the spend
            // landed is asserted through bob's credit instead.
            forwarded.catch(() => undefined);
            throw new Error("connection dropped after the relayer took the submit");
        },
    });

    /**
     * A wallet on alice's key over the shared backends.
     *
     * Every generation is built identically, so the only difference between the
     * first and its successors is what the backends already hold.
     *
     * `retries: 0` makes a dropped submit exactly one attempt: the SDK resends a
     * submit under the same key when an attempt got no response, which would put
     * a second copy on the wire and make the capture's count ambiguous.
     */
    const connectAlice = (): Promise<SdkWallet> =>
        createTestWallet(ALICE_NSK, { storage, fetch: capture.fetch, retries: 0 });

    /**
     * What the relayer charges for a transfer in `ASSET`, from the wallet's own
     * quote.
     *
     * The unknown-outcome spend returns no result, so `expectRelayerPaid` cannot
     * report its fee. A quote is the next best source: it is "computed by the
     * same code the operation runs" (`sdk/src/wallet/types/quotes.ts`), so the
     * figure it gives is the one that spend pays.
     */
    const quotedTransferFee = async (): Promise<bigint> => {
        const quote = await alice.quoteFee("transfer");
        expect(quote.charged, "this stack's relayer charges for a transfer").toBe(true);
        const option = quote.options.find((o) => o.asset.id === ASSET);
        if (!option) throw new Error(`the relayer quoted no transfer fee in asset ${ASSET}`);
        return option.amount;
    };

    beforeAll(async () => {
        // Only bob comes out of the fixture: alice has to be built with the
        // shared backends, which `setupFile` does not pass.
        const f = await setupFile({
            nsks: { bob: BOB_NSK },
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT) }],
        });
        ({ bob } = f.w);
        alice = await connectAlice();
    });

    const deposited = once(async () => {
        const r = await alice.deposit({ amount: DEPOSIT, asset: ASSET });
        await awaitOwn(alice, r);
    });

    const sentBeforeRestart = once(async () => {
        await deposited();
        const r = await alice.transfer({
            recipient: bob.address,
            amount: BEFORE_RESTART,
            asset: ASSET,
        });
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);
        return { fee: await expectRelayerPaid(r, ASSET) };
    });

    const restarted = once(async () => {
        const { fee } = await sentBeforeRestart();
        // One more sync before the wallet goes away, so what is persisted is the
        // head of every feed. Without it the "nothing was re-read" assertions
        // below would race the indexer: a leaf surfacing between the last sync
        // and the restore is one the successor legitimately folds, and nothing is
        // happening on chain for it to be about.
        await alice.sync({ scope: "full", pageSize: SYNC_LIMIT });
        // Read while the first wallet is still alive: everything after the
        // restart is compared against this.
        const before = await alice.balance(ASSET);
        const savedTree = tree.saves;
        const savedNullifiers = nullifiers.saves;
        await alice.dispose();

        alice = await connectAlice();
        // Taken before the successor syncs anything: a balance already correct
        // here can only have come out of the note store.
        const restoredCold = await alice.balance(ASSET);
        const restoredSync = await alice.sync({ scope: "full", pageSize: SYNC_LIMIT });

        // The control: same key, same feeds, empty backends.
        const fresh = await createTestWallet(ALICE_NSK);
        const freshSync = await fresh.sync({ scope: "full", pageSize: SYNC_LIMIT });
        const freshBalance = await fresh.balance(ASSET);

        return {
            fee,
            before,
            savedTree,
            savedNullifiers,
            restoredCold,
            restoredSync,
            freshSync,
            freshBalance,
        };
    });

    const spentAfterRestart = once(async () => {
        await restarted();
        const bobBefore = await shieldedBalance(bob, ASSET);
        const r = await alice.transfer({
            recipient: bob.address,
            amount: AFTER_RESTART,
            asset: ASSET,
        });
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);
        return {
            bobBefore,
            kind: r.kind,
            fee: await expectRelayerPaid(r, ASSET),
            bobAfter: await shieldedBalance(bob, ASSET),
            aliceAfter: await shieldedBalance(alice, ASSET),
        };
    });

    const unknownOutcome = once(async () => {
        await spentAfterRestart();
        const beforeSpend = await alice.balance(ASSET);
        const quoted = await quotedTransferFee();
        const bobBefore = await shieldedBalance(bob, ASSET);
        // `capture.requests` is cumulative over the file, so the attempts this
        // spend made are a delta.
        const submitsBefore = capture.requests.length;

        dropTheAnswer = true;
        let raised: unknown;
        try {
            await alice.transfer({
                recipient: bob.address,
                amount: UNKNOWN_OUTCOME,
                asset: ASSET,
            });
        } catch (e) {
            raised = e;
        } finally {
            // Restored whatever happened: later stages submit for real.
            dropTheAnswer = false;
        }
        const attempts = capture.requests.length - submitsBefore;
        const afterSpend = await alice.balance(ASSET);
        const reservedIds = isWalletError(raised, "SPEND_OUTCOME_UNKNOWN")
            ? [...raised.reservedNoteIds]
            : [];

        // Restart again and read before syncing. A lease lives in memory only
        // (`sdk/src/wallet/notes/leases.ts:15-16`), and this wallet has run no
        // spend, so a reservation it can see is one that came off disk.
        await alice.dispose();
        alice = await connectAlice();
        const afterRestart = await alice.balance(ASSET);

        return {
            beforeSpend,
            quoted,
            bobBefore,
            raised,
            attempts,
            afterSpend,
            reservedIds,
            afterRestart,
        };
    });

    const reconciled = once(async () => {
        const { bobBefore, reservedIds } = await unknownOutcome();
        // The wallet gave up; the relayer did not. Bob's credit is the only
        // observation left that the operation landed, since no result for it
        // ever reached this process.
        await awaitBalance(bob, ASSET, { above: bobBefore });
        await alice.sync({ scope: "full", pageSize: SYNC_LIMIT });
        const stored = await alice.notes({ asset: ASSET });
        return {
            balance: await alice.balance(ASSET),
            bob: await syncedBalance(bob, ASSET),
            reserved: stored.filter((n) => reservedIds.includes(n.id)),
        };
    });

    it("a wallet rebuilt on the same storage has its balance before it syncs", async () => {
        const { fee, before, savedTree, savedNullifiers, restoredCold } = await restarted();

        // What the deposit and the transfer left. The relayer's fee comes out of
        // alice's inputs, not out of bob's note, so it is subtracted here.
        expect(before.total, "balance before dispose").toBe(DEPOSIT - BEFORE_RESTART - fee);
        expect(savedTree, "the tree backend was written before dispose").toBeGreaterThan(0);
        expect(savedNullifiers, "the spent set was written before dispose").toBeGreaterThan(0);

        expect(restoredCold.total, "restored from the note store alone").toBe(before.total);
        expect(restoredCold.spendable, "and spendable, not merely counted").toBe(before.spendable);
        expect(restoredCold.withheld.reserved, "nothing was in flight").toBe(0n);
        expectBalanceAddsUp(restoredCold);
    }, TEST_TIMEOUT.SEQUENCE);

    it("the first sync after a restart fetches nothing; a cold wallet rescans everything", async () => {
        const { before, restoredSync, freshSync, freshBalance } = await restarted();

        // `fetched` counts rows pulled off the note feed, which is a firehose of
        // every note on chain rather than this wallet's own
        // (`sdk/src/sync/note-source.ts`), so it is the cost of the scan and not
        // a count of hits. Zero here because `NotesFile.cursor` round-trips
        // through `InMemoryNoteStore` and nothing lands between the dispose and
        // the restore: a caught-up wallet's first page comes back empty.
        expect(restoredSync.notes.fetched, "restored wallet re-read no notes").toBe(0);
        expect(restoredSync.notes.hits).toBe(0);

        // The two chunk feeds likewise. Their tail chunk is re-fetched on every
        // sync by design, so `chunksFetched` is never zero; `leavesAdded` and
        // `added` are what say nothing was refolded.
        const restoredTree = restoredSync.tree;
        const restoredNullifiers = restoredSync.nullifiers;
        if (!restoredTree || !restoredNullifiers) {
            throw new Error("a full sync on a spending wallet reports both chunk feeds");
        }
        expect(restoredTree.leavesAdded, "no leaf refolded").toBe(0);
        expect(restoredTree.syncedCount, "over a tree that is not empty").toBeGreaterThan(0);
        expect(restoredNullifiers.added, "no spent entry refolded").toBe(0);

        // The control pays for all of it and lands in the same place.
        const freshTree = freshSync.tree;
        if (!freshTree) throw new Error("a full sync on a spending wallet reports a tree summary");
        expect(freshSync.notes.fetched, "a cold wallet reads the whole note feed").toBeGreaterThan(0);
        expect(freshTree.leavesAdded, "and folds every leaf from zero").toBe(freshTree.syncedCount);
        expect(freshBalance.total, "both wallets agree on the balance").toBe(before.total);
    }, TEST_TIMEOUT.SEQUENCE);

    it("the restored wallet spends the notes it restored", async () => {
        const { before } = await restarted();
        const { bobBefore, kind, fee, bobAfter, aliceAfter } = await spentAfterRestart();

        // Proving a spend needs a Merkle path per input against a root the pool
        // knows, so a tree restored wrongly fails here rather than in a balance.
        expect(kind, "the spend landed as a transfer").toBe("transfer");
        expect(bobAfter, "bob credited exactly once").toBe(bobBefore + AFTER_RESTART);
        // `expectRelayerPaid` also confirms the relayer can open the fee note.
        expect(aliceAfter, "alice paid the amount and the fee out of her inputs").toBe(
            before.total - AFTER_RESTART - fee,
        );
    }, TEST_TIMEOUT.SEQUENCE);

    it("a spend the wallet got no answer to reserves its notes instead of spending them", async () => {
        const { beforeSpend, raised, attempts, afterSpend, reservedIds } = await unknownOutcome();

        if (!isWalletError(raised, "SPEND_OUTCOME_UNKNOWN")) {
            throw new Error(`the spend did not report an unknown outcome: ${describeError(raised)}`);
        }
        expect(attempts, "one attempt: `retries: 0` leaves the transport no resend").toBe(1);
        expect(reservedIds.length, "the inputs it consumed are named").toBeGreaterThan(0);
        expect(raised.reservedUntil.getTime(), "reserved into the future").toBeGreaterThan(Date.now());

        // Reserved is weaker than spent, and deliberately so: `spent` is set only
        // from evidence (`sdk/src/protocol/note-record.ts`), and this spend
        // produced none. The value stays in `total`, all of it moves under
        // `withheld.reserved`, and nothing is left to select.
        expect(afterSpend.total, "nothing was written off").toBe(beforeSpend.total);
        expect(afterSpend.withheld.reserved, "all of it is reserved").toBe(beforeSpend.total);
        expect(afterSpend.spendable, "and none of it is selectable").toBe(0n);
        expectBalanceAddsUp(afterSpend);
    }, TEST_TIMEOUT.SEQUENCE + TEST_TIMEOUT.SPEND);

    it("the reservation survives a restart", async () => {
        const { afterSpend, afterRestart } = await unknownOutcome();

        expect(afterRestart.total, "the notes came back").toBe(afterSpend.total);
        expect(afterRestart.withheld.reserved, "and so did their reservation").toBe(
            afterSpend.withheld.reserved,
        );
        expect(afterRestart.spendable, "a restart does not release them").toBe(0n);
        expectBalanceAddsUp(afterRestart);
    }, TEST_TIMEOUT.SEQUENCE + TEST_TIMEOUT.SPEND);

    it("once the spend lands, a sync settles the reservation into a spend", async () => {
        const { beforeSpend, quoted, bobBefore, reservedIds } = await unknownOutcome();
        const { balance, bob: bobAfter, reserved } = await reconciled();

        expect(bobAfter, "bob credited exactly once").toBe(bobBefore + UNKNOWN_OUTCOME);
        // `reconcileSpentOnChain` marks a note spent when its nullifier appears
        // in the mirrored spent set and clears the reservation in the same pass
        // (`sdk/src/wallet/notes/sync-ops.ts`), so no note ends up both.
        expect(reserved.length, "the reserved notes are still in the store").toBe(reservedIds.length);
        for (const n of reserved) expect(n.spent, `note ${n.cm} settled as spent`).toBe(true);
        expect(balance.withheld.reserved, "nothing is reserved any more").toBe(0n);
        // The fee is the quote the wallet took before submitting; no result for
        // this spend exists to read it from.
        expect(balance.total, "the spend is now accounted for like any other").toBe(
            beforeSpend.total - UNKNOWN_OUTCOME - quoted,
        );
        expectBalanceAddsUp(balance);
    }, TEST_TIMEOUT.SEQUENCE + TEST_TIMEOUT.SPEND);
});
