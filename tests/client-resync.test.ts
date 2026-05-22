import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    ASSET,
    createTestWallet,
    type Harness,
    awaitOwn,
    setupHarness,
    TEST_NSK,
    withFee,
} from "../src/harness.js";

const { alice: ALICE_NSK, bob: BOB_NSK } = TEST_NSK.clientResync;
const DEPOSIT_1 = 100n;
const DEPOSIT_2 = 50n;
const TO_BOB_1 = 30n;
const TO_BOB_2 = 20n;
const EXPECTED_BOB_TOTAL = TO_BOB_1 + TO_BOB_2;

describe("cold-client resync", () => {
    let h: Harness;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;
    let bob: Awaited<ReturnType<typeof createTestWallet>>;

    beforeAll(async () => {
        h = await setupHarness({
            fund: [{ kind: "erc20", token: env.token2, amount: withFee(DEPOSIT_1 + DEPOSIT_2) }],
        });
        alice = await createTestWallet(h, ALICE_NSK);
        bob = await createTestWallet(h, BOB_NSK);
    });

    it("activity sequence: 2 deposits + 2 transfers to bob", async () => {
        const d1 = await alice.deposit({ amount: DEPOSIT_1, asset: ASSET });
        await awaitOwn(alice, d1);

        const t1 = await alice.transfer({ to: bob.address, amount: TO_BOB_1, asset: ASSET });
        await awaitOwn(alice, t1);

        const d2 = await alice.deposit({ amount: DEPOSIT_2, asset: ASSET });
        await awaitOwn(alice, d2);

        const t2 = await alice.transfer({ to: bob.address, amount: TO_BOB_2, asset: ASSET });
        await awaitOwn(alice, t2);
    }, 600_000);

    it("fresh wallet reconstructs bob's balance from scratch", async () => {
        const cold = await createTestWallet(h, BOB_NSK);
        await cold.sync({ limit: 200 });
        expect(cold.balance(ASSET)).toBe(EXPECTED_BOB_TOTAL);
        expect(cold.notes({ asset: ASSET, spent: false }).length).toBe(2);
    }, 60_000);
});
