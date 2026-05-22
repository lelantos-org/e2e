import { beforeAll, describe, expect, it } from "vitest";

import {
    ASSET,
    createTestWallet,
    type Harness,
    awaitOwn,
    setupHarness,
    TEST_NSK,
    withFee,
} from "../../src/harness.js";

const { alice: NSK } = TEST_NSK.edgeConcurrent;
const DEPOSIT = 40n;

describe("edge: concurrent spends of one note", () => {
    let h: Harness;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;
    let bob: Awaited<ReturnType<typeof createTestWallet>>;

    beforeAll(async () => {
        h = await setupHarness({
            fund: [{ kind: "erc20", token: (await import("../../src/env.js")).env.token2, amount: withFee(DEPOSIT) }],
        });
        alice = await createTestWallet(h, NSK);
        bob = await createTestWallet(h, NSK + 1n);
    });

    it("only one of two parallel spends of the same note succeeds", async () => {
        const r = await alice.deposit({ amount: DEPOSIT, asset: ASSET });
        await awaitOwn(alice, r);

        // Coin selector picks the same input twice; second to hit `spent[nf]` reverts.
        const results = await Promise.allSettled([
            alice.transfer({ to: bob.address, amount: DEPOSIT, asset: ASSET }),
            alice.transfer({ to: bob.address, amount: DEPOSIT, asset: ASSET }),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled").length;
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(fulfilled).toBe(1);
        expect(rejected.length).toBe(1);
        // Error layer shifts between SDK selector, relayer, and contract.
        expect(rejected[0].reason?.message ?? String(rejected[0].reason)).toMatch(
            /spent|nullifier|already|reverted|insufficient/i,
        );
    }, 360_000);
});
