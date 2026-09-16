import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    createTestWallet,
    expectRelayerPaid,
    expectRevert,
    REVERT,
    shieldedBalance,
    SYNC_LIMIT,
    syncedBalance,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const { alice: ALICE_NSK } = TEST_NSK.doubleSpend;
const DEPOSIT_AMT = amt(50n);
// Less than the deposit: the spend also funds the relayer's fee note, so a
// wallet cannot send its entire balance. The exact amount is incidental.
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

    /// Alice's spendable note, plus a clone of her wallet synced before the
    /// note is spent. The clone is the attacker: same nsk, same note, no
    /// knowledge that the nullifier has since been published.
    const funded = once(async () => {
        const r = await alice.deposit({ amount: DEPOSIT_AMT, asset: ASSET });
        await awaitOwn(alice, r);
        const stale = await createTestWallet(ALICE_NSK);
        await stale.sync({ pageSize: SYNC_LIMIT });
        return { stale };
    });

    const spent = once(async () => {
        await funded();
        const r = await alice.transfer({ recipient: bob.address, amount: SEND_AMT, asset: ASSET });
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);
        // Only the spend that lands pays: the replay below reverts before it
        // can fund a second fee note.
        return { fee: await expectRelayerPaid(r, ASSET) };
    });

    it("deposit funds alice's spendable note", async () => {
        const { stale } = await funded();
        expect(await shieldedBalance(alice, ASSET)).toBe(DEPOSIT_AMT);
        expect(await shieldedBalance(stale, ASSET), "clone sees the same note").toBe(DEPOSIT_AMT);
    }, TEST_TIMEOUT.DEPOSIT);

    it("first transfer spends alice's note (succeeds)", async () => {
        const { fee } = await spent();
        // Not zero: the note is consumed, but the change returns minus what
        // the relayer was paid.
        expect(await shieldedBalance(alice, ASSET)).toBe(DEPOSIT_AMT - SEND_AMT - fee);
        // Synced, not cached: the baseline the replay below is measured
        // against has to be what the chain credited bob, not what his wallet
        // happened to have read.
        expect(await syncedBalance(bob, ASSET)).toBe(SEND_AMT);
    }, TEST_TIMEOUT.SEQUENCE);

    it("replay from a stale wallet is rejected", async () => {
        const { stale } = await funded();
        const { fee } = await spent();
        // The clone still believes the note is unspent, so it builds a
        // structurally valid spend over an already-published nullifier. The
        // relayer usually catches it before the pool does; see
        // `REVERT.NULLIFIER_SPENT` for why both layers are accepted.
        await expectRevert(
            stale.transfer({ recipient: bob.address, amount: SEND_AMT, asset: ASSET }),
            // Either layer answers through the relayer: its own 409, or the
            // pool revert it echoes back.
            { code: "RELAYER_REJECTED", match: REVERT.NULLIFIER_SPENT },
        );
        // Value never reached bob twice, and nothing further left alice. Both
        // synced: a cache read would pass however many notes the replay
        // produced.
        expect(await syncedBalance(bob, ASSET), "no second credit to bob").toBe(SEND_AMT);
        expect(await syncedBalance(alice, ASSET), "alice unchanged by the replay")
            .toBe(DEPOSIT_AMT - SEND_AMT - fee);
    }, TEST_TIMEOUT.SEQUENCE);
});
