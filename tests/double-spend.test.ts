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

const { alice: ALICE_NSK, bob: BOB_NSK } = TEST_NSK.doubleSpend;
const DEPOSIT_AMT = 50n;

describe("double-spend rejection", () => {
    let h: Harness;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;
    let stale: Awaited<ReturnType<typeof createTestWallet>>;
    let bob: Awaited<ReturnType<typeof createTestWallet>>;

    beforeAll(async () => {
        h = await setupHarness({
            fund: [{ kind: "erc20", token: env.token2, amount: withFee(DEPOSIT_AMT) }],
        });
        alice = await createTestWallet(h, ALICE_NSK);
        bob = await createTestWallet(h, BOB_NSK);
    });

    it("deposit funds alice's spendable note", async () => {
        const r = await alice.deposit({ amount: DEPOSIT_AMT, asset: ASSET });
        await awaitOwn(alice, r);
        expect(alice.balance(ASSET)).toBe(DEPOSIT_AMT);

        // Stale clone: same nsk, synced before the first transfer lands.
        stale = await createTestWallet(h, ALICE_NSK);
        await stale.sync({ limit: 200 });
        expect(stale.balance(ASSET)).toBe(DEPOSIT_AMT);
    }, 240_000);

    it("first transfer spends alice's note (succeeds)", async () => {
        const r = await alice.transfer({ to: bob.address, amount: DEPOSIT_AMT, asset: ASSET });
        await awaitOwn(alice, r);
        expect(alice.balance(ASSET)).toBe(0n);
        // bob's local store is empty until awaitCommitments fires.
        expect(bob.balance(ASSET)).toBe(0n);
    }, 240_000);

    it("replay from a stale wallet reverts", async () => {
        await expect(
            stale.transfer({ to: bob.address, amount: DEPOSIT_AMT, asset: ASSET }),
        ).rejects.toThrow();
    }, 240_000);
});
