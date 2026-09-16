import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    createTestWallet,
    errorText,
    expectRelayerPaid,
    FEE_HEADROOM,
    type Harness,
    isWalletError,
    REVERT,
    shieldedBalance,
    spendItem,
    syncedBalance,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../../src/harness.js";
import { setupFile, type SdkWallet } from "../../src/fixture.js";

const DEPOSIT = amt(40n);
// Below the deposit: each spend also funds a note paying the relayer, so a
// wallet cannot send its whole balance. Both racers ask for the same amount,
// which is what makes them contend for the same input note.
const SEND = amt(30n);

/**
 * Keys for the relayer-side race, kept out of `TEST_NSK.edgeConcurrent`: the
 * wallet-lease case leaves change under that alice, and a second note would let
 * the two racers pick different inputs instead of contending for one. Prefix
 * `0xec` is used by no `TEST_NSK` entry (files share one FMD index, so a
 * colliding key leaks notes across tests).
 */
const RACE_NSK = { alice: 0xec_a1ce_a11c0n, bob: 0xec_b0b_b0b00n } as const;

const isFulfilled = <T>(r: PromiseSettledResult<T>): r is PromiseFulfilledResult<T> => r.status === "fulfilled";
const isRejected = (r: PromiseSettledResult<unknown>): r is PromiseRejectedResult => r.status === "rejected";

const describeError = (e: unknown): string => (e instanceof Error ? errorText(e) : String(e));

describe("edge: concurrent spends of one note", () => {
    let h: Harness;
    let alice: SdkWallet;
    let bob: SdkWallet;

    beforeAll(async () => {
        ({ h, w: { alice, bob } } = await setupFile({
            nsks: TEST_NSK.edgeConcurrent,
            // One deposit per case, each with room for its relayer fee.
            fund: [{ asset: ASSET, amount: withFee(2n * (DEPOSIT + FEE_HEADROOM)) }],
        }));
    });

    it("the wallet leases a note to one of two concurrent spends", async () => {
        const r = await alice.deposit({ amount: DEPOSIT, asset: ASSET });
        await awaitOwn(alice, r);

        // Both race for the one note. The wallet leases a note to the spend
        // that selects it, so the loser never builds a second spend over it.
        const results = await Promise.allSettled([
            alice.transfer({ recipient: bob.address, amount: SEND, asset: ASSET }),
            alice.transfer({ recipient: bob.address, amount: SEND, asset: ASSET }),
        ]);

        const fulfilled = results.filter(isFulfilled);
        const rejected = results.filter(isRejected);
        expect(fulfilled.length, "exactly one spend lands").toBe(1);
        expect(rejected.length).toBe(1);

        // Refused locally, before proving: the note is leased to the winner, so
        // selection finds it held rather than spendable, and nothing reaches the
        // relayer's nullifier guard or the pool's `DoubleSpend`. The case below
        // covers that path, with two wallets that share no lease.
        const loser: unknown = rejected[0].reason;
        if (!isWalletError(loser, "NOTES_HELD")) {
            throw new Error(`the losing spend was not refused as NOTES_HELD: ${describeError(loser)}`);
        }
        expect(loser.asset, "held in the asset being spent").toBe(ASSET);
        expect(loser.held.reserved.count, "the one note, reserved by the winner").toBe(1);
        expect(loser.held.reserved.value).toBe(DEPOSIT);
        // The SDK sets `retryable` when spendable plus reserved plus cooling-down
        // value covers the spend: here the reserved note alone does.
        expect(loser.retryable, "the held note would cover the spend if released").toBe(true);

        // What landed: one note in, one credit out. bob is synced against the
        // winner rather than read from his still-empty local store.
        const winner = fulfilled[0].value;
        await awaitRecipient(bob, winner);
        // A spend cannot consume alice's whole balance, so she keeps change
        // and her side has to be waited on as well.
        await awaitOwn(alice, winner);
        expect(await shieldedBalance(bob, ASSET), "credited exactly once").toBe(SEND);
        const fee = await expectRelayerPaid(winner, ASSET);
        expect(await shieldedBalance(alice, ASSET), "the note is spent, not double-spent").toBe(
            DEPOSIT - SEND - fee,
        );
    }, TEST_TIMEOUT.SEQUENCE);

    it("the relayer lets one of two wallets racing the same note land", async () => {
        // Two instances of one key, each with its own in-memory store, so
        // neither holds the other's lease: both select the same note and prove
        // a spend over it, and only the relayer and the pool stand between the
        // two nullifiers.
        const first = await createTestWallet(RACE_NSK.alice);
        const second = await createTestWallet(RACE_NSK.alice);
        const recipient = await createTestWallet(RACE_NSK.bob);

        const r = await first.deposit({ amount: DEPOSIT, asset: ASSET });
        await Promise.all([awaitOwn(first, r), awaitOwn(second, r)]);
        expect(await shieldedBalance(second, ASSET), "both instances see the one note").toBe(DEPOSIT);

        const results = await Promise.allSettled([
            first.transfer({ recipient: recipient.address, amount: SEND, asset: ASSET }),
            second.transfer({ recipient: recipient.address, amount: SEND, asset: ASSET }),
        ]);

        const fulfilled = results.filter(isFulfilled);
        const rejected = results.filter(isRejected);
        expect(fulfilled.length, "exactly one spend lands").toBe(1);
        expect(rejected.length).toBe(1);

        // Which guard answers is timing: "nullifier in flight" while the
        // winner is queued or pending, "nullifier already spent" once the
        // relayer has seen it land, and the pool's `DoubleSpend` echoed back if
        // the loser got past both. Every one is the same nullifier refused, and
        // none is a local refusal.
        const loser: unknown = rejected[0].reason;
        if (!isWalletError(loser, "RELAYER_REJECTED")) {
            throw new Error(`the losing spend was not refused by the relayer: ${describeError(loser)}`);
        }
        const why = errorText(loser);
        expect(
            REVERT.NULLIFIER_REJECTED_AT_ENQUEUE.test(why) || REVERT.NULLIFIER_SPENT.test(why),
            `refused over its nullifier: ${why}`,
        ).toBe(true);

        // The winner's operation is on chain, and its note reached bob once.
        const winner = fulfilled[0].value;
        expect((await spendItem(h.provider, winner)).kind, "the winner landed as a transfer").toBe("transfer");
        await awaitRecipient(recipient, winner);
        expect(await syncedBalance(recipient, ASSET), "credited exactly once").toBe(SEND);
        // One landed spend, one fee note.
        await expectRelayerPaid(winner, ASSET);
    }, TEST_TIMEOUT.SEQUENCE);
});
