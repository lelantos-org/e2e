import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    awaitOwn,
    expectRelayerPaid,
    awaitRecipient,
    createTestWallet,
    shieldedBalance,
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
/**
 * `activity`, which every `it` pulls in: two deposits and two transfers, each
 * transfer awaited on both sides and its relayer fee confirmed.
 */
const ACTIVITY_TIMEOUT = 2 * TEST_TIMEOUT.DEPOSIT + 2 * TEST_TIMEOUT.SPEND;

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
        const afterD1 = await shieldedBalance(alice, ASSET);

        const t1 = await alice.transfer({ recipient: bob.address, amount: TO_BOB_1, asset: ASSET });
        await awaitOwn(alice, t1);
        await awaitRecipient(bob, t1);
        const afterT1 = await shieldedBalance(alice, ASSET);

        const d2 = await alice.deposit({ amount: DEPOSIT_2, asset: ASSET });
        await awaitOwn(alice, d2);
        const afterD2 = await shieldedBalance(alice, ASSET);

        const t2 = await alice.transfer({ recipient: bob.address, amount: TO_BOB_2, asset: ASSET });
        await awaitOwn(alice, t2);
        await awaitRecipient(bob, t2);
        const afterT2 = await shieldedBalance(alice, ASSET);

        // Each transfer also funds a note paying the relayer out of alice's own
        // inputs, so her running balance drops by more than she sent — and the
        // relayer is confirmed to hold both.
        return {
            afterD1, afterT1, afterD2, afterT2,
            fee1: await expectRelayerPaid(t1, ASSET),
            fee2: await expectRelayerPaid(t2, ASSET),
        };
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
        expect(await shieldedBalance(bob, ASSET), "bob, synced live").toBe(EXPECTED_BOB_TOTAL);
    }, ACTIVITY_TIMEOUT);

    it("fresh wallet reconstructs bob's balance from scratch", async () => {
        await activity();
        const cold = await createTestWallet(BOB_NSK);
        await cold.sync({ pageSize: SYNC_LIMIT });
        expect(await shieldedBalance(cold, ASSET)).toBe(EXPECTED_BOB_TOTAL);
        expect((await cold.notes({ asset: ASSET, spent: false })).length).toBe(2);
    }, ACTIVITY_TIMEOUT + TEST_TIMEOUT.LOCAL);
});
