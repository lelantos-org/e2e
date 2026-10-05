// What a payment carries besides its value, and where it can be sent.
//
// A transfer's output plaintext has a 128-byte memo field, an account has one
// address per diversifier index, and a sender can prove a payment to a third
// party. The three meet in one place: the output secret every note's
// randomness derives from binds the memo and the whole address paid, so a
// payment proof holds for exactly one address and shows exactly the memo sent.
//
// None of it is visible to the balance assertions the rest of the suite makes.
// A memo that never reached the payee, a note at a second address the scanner
// skipped, or one whose spend the circuit rejected, moves the same value.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { ViemChainReader } from "@lelantos-org/sdk/advanced";
import { verifyPaymentProof } from "@lelantos-org/sdk/protocol";

import { env } from "../src/env.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import {
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    createTestWallet,
    expectRelayerPaid,
    expectRevert,
    type Harness,
    relayerFeeWallet,
    shieldedBalance,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { BUNDLE_ITEM_EVENTS_ABI } from "../src/protocol/abi.js";

const DEPOSIT = amt(1000n);
const TO_DEFAULT = amt(100n);
const TO_DIVERSIFIED = amt(200n);
/**
 * More than either of bob's notes, so sending it back consumes both: the one at
 * his default address and the one at {@link BOB_INDEX}.
 */
const BACK = amt(250n);

/** A non-default diversifier index for bob. Any nonzero index would do. */
const BOB_INDEX = 7;

/** Multibyte on purpose: the limit is on UTF-8 bytes, not on characters. */
const MEMO = "invoice #42 — thanks";
/** Exactly the field's 128 bytes: 64 two-byte characters. */
const MEMO_MAX = "é".repeat(64);

/**
 * Wire length of every output's ciphertext: 2 B clue bits, the 224 B plaintext
 * (96 B of note fields and the 128 B memo field) and a 16 B tag.
 */
const CIPHERTEXT_BYTES = 2 + 224 + 16;

describe("memos, diversified addresses and payment proofs", () => {
    let h: Harness;
    let alice: SdkWallet;
    let bob: SdkWallet;
    /** Reads the chain with no key, as a third party checking a proof would. */
    let reader: ViemChainReader;

    beforeAll(async () => {
        ({ h, w: { alice, bob } } = await setupFile({
            nsks: TEST_NSK.memoAddresses,
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT) }],
        }));
        reader = new ViemChainReader({
            rpcUrl: env.rpcUrl,
            maspAddress: env.maspAddress,
            chainId: env.chainId,
        });
    });

    const funded = once(async () => {
        const d = await alice.deposit({ amount: DEPOSIT, asset: ASSET });
        await awaitOwn(alice, d);
        return d;
    });

    /** A payment to bob's default address, with a memo. */
    const paid = once(async () => {
        await funded();
        const r = await alice.transfer({ recipient: bob.address, amount: TO_DEFAULT, asset: ASSET, memo: MEMO });
        const fee = await expectRelayerPaid(r, ASSET);
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);
        return { r, fee };
    });

    /** A second payment, to another of bob's addresses, with a memo that fills the field. */
    const paidDiversified = once(async () => {
        await paid();
        const recipient = await bob.addressAt(BOB_INDEX);
        const r = await alice.transfer({ recipient, amount: TO_DIVERSIFIED, asset: ASSET, memo: MEMO_MAX });
        const fee = await expectRelayerPaid(r, ASSET);
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);
        return { r, fee, recipient };
    });

    const noteAt = async (w: SdkWallet, cm: string) =>
        (await w.notes({ asset: ASSET })).find((n) => n.cm.toLowerCase() === cm.toLowerCase());

    /** What `paymentProof` takes for a transfer: every field is the result's own. */
    const targetOf = (r: Awaited<ReturnType<typeof paid>>["r"], memo: string | undefined) => ({
        txHash: r.txHash,
        commitment: r.recipientCommitment,
        recipient: r.recipient,
        asset: r.amount.asset,
        amount: r.amount.amount,
        memo,
    });

    it("a memo reaches the payee's note and no other output", async () => {
        const { r } = await paid();

        const received = await noteAt(bob, r.recipientCommitment);
        expect(received, "bob recovered the note he was paid").toBeDefined();
        expect(received!.value).toBe(TO_DEFAULT);
        expect(received!.memo).toBe(MEMO);

        // The memo belongs to the paying output alone. Alice's change and the
        // relayer's fee note carry the same field, all zero.
        const change = (await alice.notes({ asset: ASSET })).filter((n) => r.ownCommitments.includes(n.cm));
        expect(change.length, "alice kept change").toBeGreaterThan(0);
        for (const n of change) expect(n.memo, `change ${n.cm}`).toBeUndefined();

        const relayer = await relayerFeeWallet();
        const feeNote = (await relayer.notes()).find((n) => r.commitments.includes(n.cm));
        expect(feeNote, "the relayer's fee note").toBeDefined();
        expect(feeNote!.memo).toBeUndefined();

        // Of the six outputs bob's keys open the payment and nothing else, and
        // alice's open only her change: the unused slots are sealed to
        // one-time addresses, not back to the sender.
        const opened = async (w: SdkWallet) =>
            (await w.notes()).map((n) => n.cm).filter((cm) => r.commitments.includes(cm)).sort();
        expect(await opened(bob)).toEqual([r.recipientCommitment]);
        expect(await opened(alice)).toEqual([...r.ownCommitments].sort());
        expect(r.ownCommitments.length, "change notes").toBeLessThanOrEqual(2);
    }, TEST_TIMEOUT.SEQUENCE);

    it("every output's ciphertext has one length, memo or none", async () => {
        const d = await funded();
        const { r } = await paid();
        const iface = new ethers.Interface(BUNDLE_ITEM_EVENTS_ABI);
        const logsOf = async (txHash: string) => {
            const receipt = await h.provider.getTransactionReceipt(txHash);
            if (receipt === null) throw new Error(`no receipt for ${txHash}`);
            return receipt.logs
                .filter((l) => l.address.toLowerCase() === env.maspAddress.toLowerCase())
                .map((l) => iface.parseLog(l))
                .filter((l): l is ethers.LogDescription => l !== null);
        };
        const bytes = (hex: string) => ethers.getBytes(hex).length;

        // One of the six outputs carries text and five do not. A length that
        // followed the memo would single out the paying output, and with it
        // which of a spend's commitments is the payment.
        const own = new Set(r.commitments.map((c) => c.toLowerCase()));
        const outputs = (await logsOf(r.txHash))
            .filter((l) => l.name === "NotePayload" && own.has(ethers.toBeHex(l.args.cm, 32).toLowerCase()));
        expect(outputs.length, "one payload per output slot").toBe(r.commitments.length);
        expect(outputs.map((l) => bytes(l.args.ciphertext)))
            .toEqual(r.commitments.map(() => CIPHERTEXT_BYTES));

        // A deposit's two leaves have no memo to carry and are the same size.
        const escrowed = (await logsOf(d.txHash)).filter((l) => l.name === "DepositEscrowed");
        expect(escrowed).toHaveLength(1);
        expect(bytes(escrowed[0].args.ciphertext), "depositor note").toBe(CIPHERTEXT_BYTES);
        expect(bytes(escrowed[0].args.feeCiphertext), "fee note").toBe(CIPHERTEXT_BYTES);
    }, TEST_TIMEOUT.SEQUENCE);

    it("refuses a memo over 128 bytes, or holding U+0000, before spending anything", async () => {
        await paid();
        const before = await shieldedBalance(alice, ASSET);
        const spendable = (await alice.notes({ asset: ASSET, spent: false })).length;

        for (const memo of [`${MEMO_MAX}!`, "a\u0000b"]) {
            await expectRevert(
                alice.transfer({ recipient: bob.address, amount: TO_DEFAULT, asset: ASSET, memo }),
                { code: "INVALID_ARGUMENT" },
            );
        }

        // Refused on the way in: no note was reserved for a spend that never ran.
        expect(await shieldedBalance(alice, ASSET)).toBe(before);
        expect((await alice.notes({ asset: ASSET, spent: false })).length).toBe(spendable);
    }, TEST_TIMEOUT.SEQUENCE);

    it("an account's addresses are distinct, stable, and indexed from the default", async () => {
        const diversified = await bob.addressAt(BOB_INDEX);

        expect(await bob.addressAt(0)).toBe(bob.address);
        expect(diversified).not.toBe(bob.address);
        expect(await bob.addressAt(BOB_INDEX + 1)).not.toBe(diversified);
        // A function of the key and the index: a second device derives the same.
        const other = await createTestWallet(TEST_NSK.memoAddresses.bob);
        expect(await other.addressAt(BOB_INDEX)).toBe(diversified);

        for (const index of [-1, 1.5, 2 ** 32]) {
            await expectRevert(bob.addressAt(index), { code: "INVALID_ARGUMENT" });
        }
    }, TEST_TIMEOUT.LOCAL);

    it("a payment to a diversified address lands in the same wallet, with a memo that fills the field", async () => {
        const { r: first } = await paid();
        const { r } = await paidDiversified();

        const received = await noteAt(bob, r.recipientCommitment);
        expect(received, "bob recovered the note sent to his other address").toBeDefined();
        expect(received!.value).toBe(TO_DIVERSIFIED);
        expect(received!.memo).toBe(MEMO_MAX);
        expect(await shieldedBalance(bob, ASSET)).toBe(TO_DEFAULT + TO_DIVERSIFIED);

        // The two notes name different diversifiers, which is what makes the
        // addresses different owners to anyone without bob's keys.
        const atDefault = await noteAt(bob, first.recipientCommitment);
        expect(received!.notePayload().d).not.toBe(atDefault!.notePayload().d);

        // The wallet keeps no copy of a memo, and bob registered no address:
        // a wallet that knows only his key reads both back off the chain.
        const cold = await createTestWallet(TEST_NSK.memoAddresses.bob);
        await cold.sync({ scope: "notes", pageSize: SYNC_LIMIT });
        expect((await noteAt(cold, first.recipientCommitment))?.memo).toBe(MEMO);
        expect((await noteAt(cold, r.recipientCommitment))?.memo).toBe(MEMO_MAX);
    }, 2 * TEST_TIMEOUT.SEQUENCE);

    it("a payment proof shows a third party the asset, value and memo, for the address paid only", async () => {
        const { r } = await paid();
        const { r: second, recipient: diversified } = await paidDiversified();

        // Through JSON, as it would travel to whoever asked for it.
        const proof = JSON.parse(JSON.stringify(await alice.paymentProof(targetOf(r, MEMO))));
        expect(await verifyPaymentProof({ proof, recipient: bob.address, reader }))
            .toEqual({ ok: true, asset: ASSET, value: TO_DEFAULT, memo: MEMO });

        const proof2 = await alice.paymentProof(targetOf(second, MEMO_MAX));
        expect(await verifyPaymentProof({ proof: proof2, recipient: diversified, reader }))
            .toEqual({ ok: true, asset: ASSET, value: TO_DIVERSIFIED, memo: MEMO_MAX });

        // The output secret binds the whole address, so the proof says nothing
        // about any other: not the sender's, and not another of the payee's own.
        for (const [who, recipient] of [["alice", alice.address], ["bob's other address", diversified]] as const) {
            expect(await verifyPaymentProof({ proof, recipient, reader }), who)
                .toEqual({ ok: false, reason: "wrong-ephemeral" });
        }
        expect(await verifyPaymentProof({ proof: proof2, recipient: bob.address, reader }), "bob's default address")
            .toEqual({ ok: false, reason: "wrong-ephemeral" });

        // Nor about another output of the same spend, or another chain.
        const change = r.ownCommitments[0];
        expect(await verifyPaymentProof({ proof: { ...proof, commitment: change }, recipient: bob.address, reader }))
            .toEqual({ ok: false, reason: "wrong-ephemeral" });
        expect(await verifyPaymentProof({ proof: { ...proof, commitment: ethers.ZeroHash }, recipient: bob.address, reader }))
            .toEqual({ ok: false, reason: "not-published" });
        expect(await verifyPaymentProof({ proof: { ...proof, chainId: "1" }, recipient: bob.address, reader }))
            .toEqual({ ok: false, reason: "wrong-chain" });
    }, 2 * TEST_TIMEOUT.SEQUENCE);

    it("only the sender can make the proof, and only with the memo that was sent", async () => {
        const { r } = await paid();

        // The memo is part of what the output secret binds: without it, or with
        // another, the sender's key does not reproduce the output.
        await expectRevert(alice.paymentProof(targetOf(r, undefined)), { code: "INVALID_ARGUMENT" });
        await expectRevert(alice.paymentProof(targetOf(r, `${MEMO}!`)), { code: "INVALID_ARGUMENT" });
        // Nor does a stated amount other than the one paid.
        await expectRevert(
            alice.paymentProof({ ...targetOf(r, MEMO), amount: TO_DEFAULT + 1n }),
            { code: "INVALID_ARGUMENT" },
        );
        // The payee holds the note and still cannot prove the payment for the sender.
        await expectRevert(bob.paymentProof(targetOf(r, MEMO)), { code: "INVALID_ARGUMENT" });
    }, TEST_TIMEOUT.SEQUENCE);

    it("a note received at a diversified address is spendable", async () => {
        const { r: first } = await paid();
        const { r: second } = await paidDiversified();
        const aliceBefore = await shieldedBalance(alice, ASSET);

        // Larger than either note, so the spend takes both. The circuit derives
        // each input's `pk` from the spender's key and the note's own
        // diversifier, so a note at a non-default address proves only if the
        // wallet kept the diversifier it was received at.
        const r = await bob.transfer({ recipient: await alice.addressAt(1), amount: BACK, asset: ASSET });
        const fee = await expectRelayerPaid(r, ASSET);
        await awaitOwn(bob, r);
        await awaitRecipient(alice, r);

        expect(await shieldedBalance(bob, ASSET)).toBe(TO_DEFAULT + TO_DIVERSIFIED - BACK - fee);
        expect(await shieldedBalance(alice, ASSET)).toBe(aliceBefore + BACK);
        expect((await noteAt(alice, r.recipientCommitment))?.memo, "no memo was sent").toBeUndefined();

        // A cold wallet knows only what it syncs: both inputs' nullifiers landed.
        const cold = await createTestWallet(TEST_NSK.memoAddresses.bob);
        await cold.sync({ scope: "notes", pageSize: SYNC_LIMIT });
        for (const cm of [first.recipientCommitment, second.recipientCommitment]) {
            expect((await noteAt(cold, cm))?.spent, `input ${cm} nullified on chain`).toBe(true);
        }
    }, 3 * TEST_TIMEOUT.SEQUENCE);
});
