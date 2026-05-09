// E2E: 2-of-2 input slots — merge two real spendable notes in a single
// transfer.
//   1. deposit 30 → alice note A.
//   2. deposit 70 → alice note B.
//   3. transfer with inputs [A, B] (no null pad) → output 100 to bob,
//      0-pad change back to alice.
// Asserts both nullifiers spent, value conservation, tree advances by 2.

import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env";
import {
    buildNullifierFromNsk,
    counter,
    deposit,
    type Harness,
    makeWallet,
    newAuxRng,
    nfToHex,
    type Note,
    noteFor,
    setupHarness,
    type SpendableCachedNote,
    submitTransfer,
    type TestWallet,
    withFee,
} from "../src/harness";

const ALICE_NSK = 11n;
const BOB_NSK = 22n;
const DEPOSIT_A = 30n;
const DEPOSIT_B = 70n;
const TOTAL = DEPOSIT_A + DEPOSIT_B;

describe("two-input merge transfer", () => {
    let h: Harness;
    let alice: TestWallet;
    let bob: TestWallet;
    let noteA: SpendableCachedNote;
    let noteB: SpendableCachedNote;

    const aliceRng = counter(0xa11cen);
    const bobRng = counter(0xb0bn);
    const auxRng = newAuxRng();

    beforeAll(async () => {
        h = await setupHarness({
            fund: [{ kind: "erc20", token: env.token2, amount: withFee(TOTAL) }],
        });
        alice = makeWallet(h.P, h.J, ALICE_NSK);
        bob = makeWallet(h.P, h.J, BOB_NSK);
    });

    it("two deposits give alice two spendable notes", async () => {
        noteA = await deposit({ h, wallet: alice, nsk: ALICE_NSK, amount: DEPOSIT_A, rng: aliceRng, auxRng });
        noteB = await deposit({ h, wallet: alice, nsk: ALICE_NSK, amount: DEPOSIT_B, rng: aliceRng, auxRng });
        expect(noteA.note.value).toBe(DEPOSIT_A);
        expect(noteB.note.value).toBe(DEPOSIT_B);
        expect(noteA.leafIndex).not.toBe(noteB.leafIndex);
    });

    it("transfer consumes BOTH inputs, lands a single 100-note for bob", async () => {
        const bobOut: Note = noteFor(bob, TOTAL, bobRng);
        const aliceChange: Note = noteFor(alice, 0n, aliceRng);
        const before = await h.masp.committedCount();

        await submitTransfer({
            h,
            inputs: [noteA, noteB],
            outputs: [bobOut, aliceChange],
            recipients: [bob, alice],
            auxRng,
        });

        // Both nullifiers spent on-chain.
        const nfA = buildNullifierFromNsk(h.P, ALICE_NSK, noteA.note.rho);
        const nfB = buildNullifierFromNsk(h.P, ALICE_NSK, noteB.note.rho);
        const spentA = await h.masp.spent(nfToHex(nfA));
        const spentB = await h.masp.spent(nfToHex(nfB));
        expect(spentA).toBe(true);
        expect(spentB).toBe(true);
        // Tree advanced by exactly 2 leaves (one per output cm).
        const committedAfter = await h.masp.committedCount();
        expect(committedAfter).toBe(before + 2n);
        // Value conservation.
        expect(bobOut.value).toBe(DEPOSIT_A + DEPOSIT_B);
    });
});
