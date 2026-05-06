// E2E: 2-of-2 input slots — merge two real spendable notes in a single
// transfer.
//   1. deposit 30 → alice note A.
//   2. deposit 70 → alice note B.
//   3. transfer with inputs [A, B] (no null pad) → output 100 to bob,
//      0-pad change back to alice.
// Asserts:
//   - both nullifiers land in masp.spent
//   - value conservation: bob's output value = A.value + B.value
//   - tree advances by exactly 2 leaves on the transfer (one per output)
//
// Other e2e tests only ever use [slot, null]; this exercises the
// [slot, slot] code path in buildTransfer + the circuit's two-real-input
// witness layout.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import {
    buildNullifierFromNsk,
    buildTransfer,
    FmdClient,
    Jubjub,
    type Note,
    Poseidon,
    RelayerClient,
    type SpendableCachedNote,
} from "@lelantos-org/sdk";

import { env } from "../src/env";
import {
    counter,
    inputSlotFor,
    MASP_ABI,
    makeWallet,
    nfToHex,
    noteFor,
    rngForOutput,
    setupErc20,
    type TestWallet,
    waitForCm,
} from "../src/scenario";
import {
    currentRoot,
    depositToWallet,
    makeBundleCommon,
    newAuxRng,
    waitForFmdHealth,
} from "./_shared";

const ALICE_NSK = 11n;
const BOB_NSK = 22n;
const DEPOSIT_A = 30n;
const DEPOSIT_B = 70n;
const TOTAL = DEPOSIT_A + DEPOSIT_B;

describe("two-input merge transfer", () => {
    let P: Poseidon;
    let J: Jubjub;
    let masp: ethers.Contract;
    let relayer: RelayerClient;
    let fmd: FmdClient;
    let alice: TestWallet;
    let bob: TestWallet;
    let noteA: SpendableCachedNote;
    let noteB: SpendableCachedNote;

    const aliceRng = counter(0xa11cen);
    const bobRng = counter(0xb0bn);
    const auxRng = newAuxRng();

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        const provider = new ethers.JsonRpcProvider(env.rpcUrl);
        const payer = new ethers.Wallet(env.payerKey, provider);
        masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
        relayer = new RelayerClient(env.relayerUrl);
        fmd = new FmdClient(env.fmdUrl, env.chainId);
        await setupErc20(payer, env.token2, env.maspAddress, TOTAL);

        await waitForFmdHealth();

        alice = makeWallet(P, J, ALICE_NSK);
        bob = makeWallet(P, J, BOB_NSK);
    });

    it("two deposits give alice two spendable notes", async () => {
        noteA = await depositToWallet({
            P, J, relayer, fmd, wallet: alice, nsk: ALICE_NSK,
            amount: DEPOSIT_A, rng: aliceRng, auxRng,
        });
        noteB = await depositToWallet({
            P, J, relayer, fmd, wallet: alice, nsk: ALICE_NSK,
            amount: DEPOSIT_B, rng: aliceRng, auxRng,
        });
        expect(noteA.note.value).toBe(DEPOSIT_A);
        expect(noteB.note.value).toBe(DEPOSIT_B);
        // Distinct leaves.
        expect(noteA.leafIndex).not.toBe(noteB.leafIndex);
    });

    it("transfer consumes BOTH inputs, lands a single 100-note for bob", async () => {
        const bobOut: Note = noteFor(bob, TOTAL, bobRng);
        const aliceChange: Note = noteFor(alice, 0n, aliceRng);

        const maspBalBefore = await masp.committedCount();

        const built = await buildTransfer({
            ...makeBundleCommon(P, J),
            inputs: [
                await inputSlotFor(P, fmd, noteA),
                await inputSlotFor(P, fmd, noteB),
            ],
            merkleRoot: await currentRoot(fmd),
            outputs: [bobOut, aliceChange],
            outputRecipients: [bob.recipient, alice.recipient],
            outputRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });
        await relayer.submitTransact(built.payload);

        // Both outputs indexed.
        await waitForCm(fmd, built.cm[0]);
        await waitForCm(fmd, built.cm[1]);

        // Both nullifiers spent on-chain.
        const nfA = buildNullifierFromNsk(P, ALICE_NSK, noteA.note.rho);
        const nfB = buildNullifierFromNsk(P, ALICE_NSK, noteB.note.rho);
        expect(await masp.spent(nfToHex(nfA))).toBe(true);
        expect(await masp.spent(nfToHex(nfB))).toBe(true);

        // Tree advanced by exactly 2 leaves (one per output cm).
        expect(await masp.committedCount()).toBe(maspBalBefore + 2n);

        // Value conservation: bob's note carries the full sum.
        expect(bobOut.value).toBe(DEPOSIT_A + DEPOSIT_B);
    });
});
