import { beforeAll, describe, expect, it } from "vitest";

import type { TransactionResult, TransferResult } from "@lelantos-org/sdk";

import {
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    feePaid,
    errorText,
    REVERT,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../../src/harness.js";
import { setupFile, type SdkWallet } from "../../src/fixture.js";

const DEPOSIT = amt(40n);
// Below the deposit: each spend also funds a note paying the relayer, so a
// wallet can never send its whole balance. Both racers ask for the same
// amount, which is what makes them contend for the same input note.
const SEND = amt(30n);

describe("edge: concurrent spends of one note", () => {
    let alice: SdkWallet;
    let bob: SdkWallet;

    beforeAll(async () => {
        ({ w: { alice, bob } } = await setupFile({
            nsks: TEST_NSK.edgeConcurrent,
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT) }],
        }));
    });

    it("only one of two parallel spends of the same note succeeds", async () => {
        const r = await alice.deposit({ amount: DEPOSIT, asset: ASSET });
        await awaitOwn(alice, r);

        // Coin selector picks the same input twice; the loser hits the
        // nullifier guard.
        const results = await Promise.allSettled([
            alice.transfer({ to: bob.address, amount: SEND, asset: ASSET }),
            alice.transfer({ to: bob.address, amount: SEND, asset: ASSET }),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(fulfilled.length, "exactly one spend lands").toBe(1);
        expect(rejected.length).toBe(1);

        expect(errorText(rejected[0].reason)).toMatch(REVERT.NULLIFIER_CONTESTED);

        // The decisive property, and the reason a rejection alone is not
        // enough: one note in, one credit out. Sync bob against the winner
        // rather than reading his (still empty) local store — an unsynced
        // wallet reporting zero would "pass" even if the note had been spent
        // twice.
        const winner = (fulfilled[0] as PromiseFulfilledResult<TransactionResult>).value;
        await awaitRecipient(bob, winner);
        // Alice keeps change now that a spend cannot consume her whole
        // balance, so her side has to be waited on too.
        await awaitOwn(alice, winner);
        expect(bob.balance(ASSET), "credited exactly once").toBe(SEND);
        // The input note is gone and alice keeps the change, less the fee the
        // winning spend paid the relayer.
        expect(alice.balance(ASSET), "the note is spent, not double-spent").toBe(
            DEPOSIT - SEND - feePaid(winner as TransferResult),
        );
    }, TEST_TIMEOUT.SWAP);
});
