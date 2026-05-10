// E2E negative path: nullifier replay rejection.
//   1. deposit 50 → alice gets a spendable note.
//   2. transfer 50 to bob (succeeds) — alice's note is now spent.
//   3. rebuild a fresh transfer reusing the same input note (same nsk +
//      rho ⇒ same nullifier) and submit it. Expect: relayer/contract
//      revert because masp.spent[nf] is already true.

import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env";
import {
    buildNullifierFromNsk,
    counter,
    deposit,
    type Harness,
    inputSlotFor,
    makeWallet,
    newAuxRng,
    nfToHex,
    type Note,
    noteFor,
    rngForOutput,
    setupHarness,
    type SpendableCachedNote,
    submitTransfer,
    type TestWallet,
    withFee,
} from "../src/harness";
import { buildTransfer } from "@lelantos-org/sdk";

// File-unique seeds; see full-flow.test.ts for the rationale.
const ALICE_NSK = 0xdd_a1ce_a11c0n;
const BOB_NSK = 0xdd_b0b_b0b00n;
const DEPOSIT_AMT = 50n;

describe("double-spend rejection", () => {
    let h: Harness;
    let alice: TestWallet;
    let bob: TestWallet;
    let aliceNote: SpendableCachedNote;

    const aliceRng = counter(0xdd_a1ce_0001n);
    const bobRng = counter(0xdd_b0b_0001n);
    const auxRng = newAuxRng(0xdd_add_0001n);

    beforeAll(async () => {
        h = await setupHarness({
            fund: [{ kind: "erc20", token: env.token2, amount: withFee(DEPOSIT_AMT) }],
        });
        alice = makeWallet(h.P, h.J, ALICE_NSK);
        bob = makeWallet(h.P, h.J, BOB_NSK);
    });

    it("deposit funds alice's spendable note", async () => {
        aliceNote = await deposit({
            h, wallet: alice, nsk: ALICE_NSK, amount: DEPOSIT_AMT, rng: aliceRng, auxRng,
        });
    });

    it("first transfer spends alice's note (succeeds)", async () => {
        const bobOut: Note = noteFor(bob, DEPOSIT_AMT, bobRng);
        const aliceChange: Note = noteFor(alice, 0n, aliceRng);

        await submitTransfer({
            h,
            inputs: [aliceNote],
            outputs: [bobOut, aliceChange],
            recipients: [bob, alice],
            auxRng,
        });

        const spentNf = buildNullifierFromNsk(h.P, ALICE_NSK, aliceNote.note.rho);
        const isSpent = await h.masp.spent(nfToHex(spentNf));
        expect(isSpent).toBe(true);
    });

    it("replay with same input nullifier reverts", async () => {
        // Same input note + same nsk ⇒ same nullifier. Output randomness
        // is rolled forward, so any revert points squarely at the spent
        // nullifier and not at a cm collision.
        const bobOut: Note = noteFor(bob, DEPOSIT_AMT, bobRng);
        const aliceChange: Note = noteFor(alice, 0n, aliceRng);

        const built = await buildTransfer({
            ...h.bundleCommon(),
            inputs: [await inputSlotFor(h.P, h.fmd, aliceNote), null],
            merkleRoot: await h.currentRoot(),
            outputs: [bobOut, aliceChange],
            outputRecipients: [bob.recipient, alice.recipient],
            outputRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });

        await expect(h.relayer.submitTransact(built.payload)).rejects.toThrow();

        const spentNf = buildNullifierFromNsk(h.P, ALICE_NSK, aliceNote.note.rho);
        const isSpent = await h.masp.spent(nfToHex(spentNf));
        expect(isSpent).toBe(true);
    });
});
