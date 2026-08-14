import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    type Harness,
    N_OUT,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const DEPOSIT_A = amt(30n);
const DEPOSIT_B = amt(70n);
const TOTAL = amt(DEPOSIT_A + DEPOSIT_B);

describe("two-input merge transfer", () => {
    let h: Harness;
    let alice: SdkWallet;
    let bob: SdkWallet;

    beforeAll(async () => {
        ({ h, w: { alice, bob } } = await setupFile({
            nsks: TEST_NSK.twoInputMerge,
            fund: [{ asset: ASSET, amount: withFee(TOTAL) }],
        }));
    });

    const funded = once(async () => {
        const a = await alice.deposit({ amount: DEPOSIT_A, asset: ASSET });
        await awaitOwn(alice, a);
        const b = await alice.deposit({ amount: DEPOSIT_B, asset: ASSET });
        await awaitOwn(alice, b);
    });

    it("two deposits give alice two spendable notes", async () => {
        await funded();
        expect(alice.balance(ASSET)).toBe(TOTAL);
        expect(alice.notes({ asset: ASSET, spent: false }).length).toBe(2);
    }, TEST_TIMEOUT.SWAP);

    it("transfer consumes BOTH inputs, lands a single 100-note for bob", async () => {
        await funded();
        // Deltas, not absolutes: the MASP is shared across all test files.
        const before = (await h.masp.committedCount()) as bigint;
        const inputNotesBefore = alice.notes({ asset: ASSET, spent: false });
        expect(inputNotesBefore.length).toBe(2);

        const r = await alice.transfer({ to: bob.address, amount: TOTAL, asset: ASSET });
        // Alice sends her entire balance, so there is no change note and
        // nothing of hers to wait for — assert that rather than branching on
        // it, so a selector change that starts producing change is a visible
        // failure instead of a silently skipped wait.
        expect(r.ownCommitments, "full-balance spend leaves no change note").toHaveLength(0);
        await awaitRecipient(bob, r);

        for (const n of inputNotesBefore) {
            expect(
                alice.notes({ asset: ASSET, spent: true }).find((x) => x.cm === n.cm),
                `input ${n.cm} marked spent`,
            ).toBeDefined();
        }
        expect((await h.masp.committedCount()) as bigint).toBe(before + BigInt(N_OUT));
        expect(alice.balance(ASSET)).toBe(0n);
        expect(bob.balance(ASSET)).toBe(TOTAL);
    }, TEST_TIMEOUT.SPEND);
});
