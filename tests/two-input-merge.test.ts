import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    awaitOwn,
    expectRelayerPaid,
    awaitRecipient,
    createTestWallet,
    type Harness,
    shieldedBalance,
    SYNC_LIMIT,
    spendItem,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const { alice: ALICE_NSK } = TEST_NSK.twoInputMerge;
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
        expect(await shieldedBalance(alice, ASSET)).toBe(TOTAL);
        expect((await alice.notes({ asset: ASSET, spent: false })).length).toBe(2);
    }, 2 * TEST_TIMEOUT.DEPOSIT);

    it("transfer consumes BOTH inputs, lands a single note for bob", async () => {
        await funded();
        const inputNotesBefore = await alice.notes({ asset: ASSET, spent: false });
        expect(inputNotesBefore.length).toBe(2);

        const r = await alice.transfer({ recipient: bob.address, amount: SEND_AMT, asset: ASSET });
        // A two-input spend funds one fee note, not one per input.
        const fee = await expectRelayerPaid(r, ASSET);
        // Both inputs are consumed and alice keeps the remainder, so there is
        // change to wait for on her side as well as bob's.
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);

        // Alice's own wallet marks its inputs spent as soon as the relayer
        // accepts the spend, so it cannot show the chain consumed them. A cold
        // wallet on the same key knows only what it syncs: an input it still
        // sees unspent is one whose nullifier never landed.
        const cold = await createTestWallet(ALICE_NSK);
        await cold.sync({ scope: "notes", pageSize: SYNC_LIMIT });
        const spentOnChain = await cold.notes({ asset: ASSET, spent: true });
        for (const n of inputNotesBefore) {
            expect(
                spentOnChain.find((x) => x.cm === n.cm),
                `input ${n.cm} nullified on chain`,
            ).toBeDefined();
        }
        // The transfer's own operation, not a `committedCount` delta: the
        // relayer bundles, so its transaction can carry other operations.
        expect((await spendItem(h.provider, r)).kind).toBe("transfer");
        expect(await shieldedBalance(alice, ASSET)).toBe(TOTAL - SEND_AMT - fee);
        expect(await shieldedBalance(bob, ASSET)).toBe(SEND_AMT);
    }, TEST_TIMEOUT.SEQUENCE);
});
