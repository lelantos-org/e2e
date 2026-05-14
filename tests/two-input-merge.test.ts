import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    ASSET,
    createTestWallet,
    type Harness,
    POLL,
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
        await alice.awaitCommitments(a.commitments, POLL.COMMITMENT);
        const b = await alice.deposit({ amount: DEPOSIT_B, asset: ASSET });
        await alice.awaitCommitments(b.commitments, POLL.COMMITMENT);
        expect(alice.balance(ASSET)).toBe(TOTAL);
        expect(alice.notes({ asset: ASSET, spent: false }).length).toBe(2);
    }, 360_000);

    it("transfer consumes BOTH inputs, lands a single 100-note for bob", async () => {
        const before = await h.masp.committedCount();
        const inputNotesBefore = alice.notes({ asset: ASSET, spent: false });
        expect(inputNotesBefore.length).toBe(2);

        const r = await alice.transfer({ to: bob.address, amount: TOTAL, asset: ASSET });
        await alice.awaitCommitments(r.commitments, POLL.SPEND);
        await bob.awaitCommitments(r.commitments, POLL.SPEND);

        for (const n of inputNotesBefore) {
            expect(alice.notes({ asset: ASSET, spent: true }).find((x) => x.cm === n.cm)).toBeDefined();
        }
        expect(await h.masp.committedCount()).toBe(before + 2n);
        expect(alice.balance(ASSET)).toBe(0n);
        expect(bob.balance(ASSET)).toBe(TOTAL);
    }, 240_000);
});
