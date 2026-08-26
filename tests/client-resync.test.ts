import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    awaitOwn,
    feePaid,
    awaitRecipient,
    createTestWallet,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const { bob: BOB_NSK } = TEST_NSK.clientResync;
const DEPOSIT_1 = amt(100n);
const DEPOSIT_2 = amt(50n);
const TO_BOB_1 = amt(30n);
const TO_BOB_2 = amt(20n);
const EXPECTED_BOB_TOTAL = TO_BOB_1 + TO_BOB_2;

describe("cold-client resync", () => {
    let alice: SdkWallet;
    let bob: SdkWallet;

    beforeAll(async () => {
        ({ w: { alice, bob } } = await setupFile({
            nsks: TEST_NSK.clientResync,
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT_1 + DEPOSIT_2) }],
        }));
    });

    /// The history a cold client has to reconstruct: interleaved deposits and
    /// transfers, so bob's two notes are separated by an unrelated deposit and
    /// are not the last two leaves in the tree.
    const activity = once(async () => {
        const d1 = await alice.deposit({ amount: DEPOSIT_1, asset: ASSET });
        await awaitOwn(alice, d1);
        const afterD1 = alice.balance(ASSET);

        const t1 = await alice.transfer({ to: bob.address, amount: TO_BOB_1, asset: ASSET });
        await awaitOwn(alice, t1);
        await awaitRecipient(bob, t1);
        const afterT1 = alice.balance(ASSET);

        const d2 = await alice.deposit({ amount: DEPOSIT_2, asset: ASSET });
        await awaitOwn(alice, d2);
        const afterD2 = alice.balance(ASSET);

        const t2 = await alice.transfer({ to: bob.address, amount: TO_BOB_2, asset: ASSET });
        await awaitOwn(alice, t2);
        await awaitRecipient(bob, t2);
        const afterT2 = alice.balance(ASSET);

        // Each transfer also funds a note paying the relayer out of alice's own
        // inputs, so her running balance drops by more than she sent.
        return { afterD1, afterT1, afterD2, afterT2, fee1: feePaid(t1), fee2: feePaid(t2) };
    });

    it("activity sequence: 2 deposits + 2 transfers to bob", async () => {
        const { afterD1, afterT1, afterD2, afterT2, fee1, fee2 } = await activity();
        expect(afterD1, "after deposit 1").toBe(DEPOSIT_1);
        expect(afterT1, "after transfer 1").toBe(DEPOSIT_1 - TO_BOB_1 - fee1);
        expect(afterD2, "after deposit 2").toBe(DEPOSIT_1 - TO_BOB_1 - fee1 + DEPOSIT_2);
        expect(afterT2, "after transfer 2").toBe(
            DEPOSIT_1 + DEPOSIT_2 - TO_BOB_1 - TO_BOB_2 - fee1 - fee2,
        );
        // The warm counterparty saw both incoming notes as they landed.
        expect(bob.balance(ASSET), "bob, synced live").toBe(EXPECTED_BOB_TOTAL);
    }, TEST_TIMEOUT.SEQUENCE);

    it("fresh wallet reconstructs bob's balance from scratch", async () => {
        await activity();
        const cold = await createTestWallet(BOB_NSK);
        await cold.sync({ limit: SYNC_LIMIT });
        expect(cold.balance(ASSET)).toBe(EXPECTED_BOB_TOTAL);
        expect(cold.notes({ asset: ASSET, spent: false }).length).toBe(2);
    }, TEST_TIMEOUT.LOCAL);
});
