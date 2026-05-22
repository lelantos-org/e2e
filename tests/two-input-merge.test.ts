import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    ASSET,
    createTestWallet,
    type Harness,
    awaitOwn,
    awaitRecipient,
    setupHarness,
    TEST_NSK,
    withFee,
} from "../src/harness.js";

const { alice: ALICE_NSK, bob: BOB_NSK } = TEST_NSK.twoInputMerge;
const DEPOSIT_A = 30n;
const DEPOSIT_B = 70n;
const TOTAL = DEPOSIT_A + DEPOSIT_B;

describe("two-input merge transfer", () => {
    let h: Harness;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;
    let bob: Awaited<ReturnType<typeof createTestWallet>>;

    beforeAll(async () => {
        h = await setupHarness({
            fund: [{ kind: "erc20", token: env.token2, amount: withFee(TOTAL) }],
        });
        alice = await createTestWallet(h, ALICE_NSK);
        bob = await createTestWallet(h, BOB_NSK);
    });

    it("two deposits give alice two spendable notes", async () => {
        const a = await alice.deposit({ amount: DEPOSIT_A, asset: ASSET });
        await awaitOwn(alice, a);
        const b = await alice.deposit({ amount: DEPOSIT_B, asset: ASSET });
        await awaitOwn(alice, b);
        expect(alice.balance(ASSET)).toBe(TOTAL);
        expect(alice.notes({ asset: ASSET, spent: false }).length).toBe(2);
    }, 360_000);

    it("transfer consumes BOTH inputs, lands a single 100-note for bob", async () => {
        const before = await h.masp.committedCount();
        const inputNotesBefore = alice.notes({ asset: ASSET, spent: false });
        expect(inputNotesBefore.length).toBe(2);

        const r = await alice.transfer({ to: bob.address, amount: TOTAL, asset: ASSET });
        // alice spends everything → her ownCommitments is empty (no change),
        // so just wait for cms to surface on-chain. bob waits on the
        // recipient cm (the non-own subset).
        if (r.ownCommitments.length > 0) {
            await awaitOwn(alice, r);
        }
        await awaitRecipient(bob, r);

        for (const n of inputNotesBefore) {
            expect(alice.notes({ asset: ASSET, spent: true }).find((x) => x.cm === n.cm)).toBeDefined();
        }
        expect(await h.masp.committedCount()).toBe(before + 2n);
        expect(alice.balance(ASSET)).toBe(0n);
        expect(bob.balance(ASSET)).toBe(TOTAL);
    }, 240_000);
});
