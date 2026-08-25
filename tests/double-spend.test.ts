import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    awaitOwn,
    createTestWallet,
    expectRevert,
    feePaid,
    REVERT,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const { alice: ALICE_NSK } = TEST_NSK.doubleSpend;
const DEPOSIT_AMT = amt(50n);
// Less than the deposit: the spend also has to fund the relayer's fee note,
// so a wallet can never send its entire balance. The exact amount is
// incidental — this file is about spending one note twice.
const SEND_AMT = amt(40n);

describe("double-spend rejection", () => {
    let alice: SdkWallet;
    let bob: SdkWallet;

    beforeAll(async () => {
        ({ w: { alice, bob } } = await setupFile({
            nsks: TEST_NSK.doubleSpend,
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT_AMT) }],
        }));
    });

    /// Alice's spendable note, plus a clone of her wallet synced *before* the
    /// note is spent. The clone is the attacker: same nsk, same note, no
    /// knowledge that the nullifier has since been published.
    const funded = once(async () => {
        const r = await alice.deposit({ amount: DEPOSIT_AMT, asset: ASSET });
        await awaitOwn(alice, r);
        const stale = await createTestWallet(ALICE_NSK);
        await stale.sync({ limit: SYNC_LIMIT });
        return { stale };
    });

    const spent = once(async () => {
        await funded();
        const r = await alice.transfer({ to: bob.address, amount: SEND_AMT, asset: ASSET });
        await awaitOwn(alice, r);
        return { fee: feePaid(r) };
    });

    it("deposit funds alice's spendable note", async () => {
        const { stale } = await funded();
        expect(alice.balance(ASSET)).toBe(DEPOSIT_AMT);
        expect(stale.balance(ASSET), "clone sees the same note").toBe(DEPOSIT_AMT);
    }, TEST_TIMEOUT.SPEND);

    it("first transfer spends alice's note (succeeds)", async () => {
        const { fee } = await spent();
        // Not zero: the note is consumed, but the change comes back minus
        // what the relayer was paid to relay it.
        expect(alice.balance(ASSET)).toBe(DEPOSIT_AMT - SEND_AMT - fee);
        // bob's local store is empty until awaitCommitments fires.
        expect(bob.balance(ASSET)).toBe(0n);
    }, TEST_TIMEOUT.SPEND);

    it("replay from a stale wallet is rejected", async () => {
        const { stale } = await funded();
        await spent();
        // The clone still believes the note is unspent, so it builds a
        // structurally valid spend over an already-published nullifier. In
        // practice the relayer catches it before the pool does — see
        // `REVERT.NULLIFIER_SPENT` for why both layers are accepted.
        await expectRevert(
            stale.transfer({ to: bob.address, amount: SEND_AMT, asset: ASSET }),
            REVERT.NULLIFIER_SPENT,
        );
        // The note is still Alice's, unspent value never moved to bob twice.
        expect(bob.balance(ASSET), "no second credit to bob").toBe(0n);
    }, TEST_TIMEOUT.SPEND);
});
