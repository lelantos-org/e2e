import { beforeAll, describe, expect, it } from "vitest";

import type { TransactionResult } from "@lelantos-org/sdk";

import {
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    REVERT,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../../src/harness.js";
import { setupFile, type SdkWallet } from "../../src/fixture.js";

const DEPOSIT = amt(40n);

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
            alice.transfer({ to: bob.address, amount: DEPOSIT, asset: ASSET }),
            alice.transfer({ to: bob.address, amount: DEPOSIT, asset: ASSET }),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(fulfilled.length, "exactly one spend lands").toBe(1);
        expect(rejected.length).toBe(1);

        const reason = rejected[0].reason;
        const message = `${reason?.message ?? ""} || ${String(reason)}`;
        expect(message).toMatch(REVERT.NULLIFIER_CONTESTED);

        // The decisive property, and the reason a rejection alone is not
        // enough: one note in, one credit out. Sync bob against the winner
        // rather than reading his (still empty) local store — an unsynced
        // wallet reporting zero would "pass" even if the note had been spent
        // twice.
        const winner = (fulfilled[0] as PromiseFulfilledResult<TransactionResult>).value;
        await awaitRecipient(bob, winner);
        expect(bob.balance(ASSET), "credited exactly once").toBe(DEPOSIT);
        expect(alice.balance(ASSET), "the note is spent, not double-spent").toBe(0n);
    }, TEST_TIMEOUT.SWAP);
});
