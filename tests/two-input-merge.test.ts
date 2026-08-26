import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    awaitOwn,
    feePaid,
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
/**
 * More than either note alone, so the selector has to consume both, but below
 * `TOTAL` by more than the relayer's fee, since the spend must also fund the
 * fee note.
 */
const SEND_AMT = amt(DEPOSIT_B + 25n);

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

    it("transfer consumes BOTH inputs, lands a single note for bob", async () => {
        await funded();
        // Deltas, not absolutes: the MASP is shared across test files.
        const before = (await h.masp.committedCount()) as bigint;
        const inputNotesBefore = alice.notes({ asset: ASSET, spent: false });
        expect(inputNotesBefore.length).toBe(2);

        const r = await alice.transfer({ to: bob.address, amount: SEND_AMT, asset: ASSET });
        const fee = feePaid(r);
        // Both inputs are consumed and alice keeps the remainder, so there is
        // change to wait for on her side as well as bob's.
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);

        for (const n of inputNotesBefore) {
            expect(
                alice.notes({ asset: ASSET, spent: true }).find((x) => x.cm === n.cm),
                `input ${n.cm} marked spent`,
            ).toBeDefined();
        }
        expect((await h.masp.committedCount()) as bigint).toBe(before + BigInt(N_OUT));
        expect(alice.balance(ASSET)).toBe(TOTAL - SEND_AMT - fee);
        expect(bob.balance(ASSET)).toBe(SEND_AMT);
    }, TEST_TIMEOUT.SPEND);
});
