// E2E negative path: nullifier replay rejection.
//   1. deposit 50 → alice gets a spendable note.
//   2. transfer 50 to bob (succeeds) — alice's note is now spent.
//   3. rebuild a fresh transfer reusing the same input note (same nsk +
//      rho ⇒ same nullifier) and submit it. Expect: relayer/contract
//      revert because masp.spent[nf] is already true.
//
// Output randomness is rolled forward for the second attempt so the only
// duplicated artifact across the two submits is the input nullifier —
// any failure mode therefore points at replay protection, not at cm
// collisions.
//
// Merkle paths come from fmd-webserver (no local mirror) — same rule as
// the rest of the e2e suite.

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
const DEPOSIT = 50n;

describe("double-spend rejection", () => {
    let P: Poseidon;
    let J: Jubjub;
    let masp: ethers.Contract;
    let relayer: RelayerClient;
    let fmd: FmdClient;
    let alice: TestWallet;
    let bob: TestWallet;
    let aliceNote: SpendableCachedNote;

    const aliceRng = counter(0xdeadbeefn);
    const bobRng = counter(0xb0bbn);
    const auxRng = newAuxRng();

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        const provider = new ethers.JsonRpcProvider(env.rpcUrl);
        const payer = new ethers.Wallet(env.payerKey, provider);
        masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
        relayer = new RelayerClient(env.relayerUrl);
        fmd = new FmdClient(env.fmdUrl, env.chainId);
        await setupErc20(payer, env.token2, env.maspAddress, DEPOSIT);

        await waitForFmdHealth();

        alice = makeWallet(P, J, ALICE_NSK);
        bob = makeWallet(P, J, BOB_NSK);
    });

    it("deposit funds alice's spendable note", async () => {
        aliceNote = await depositToWallet({
            P, J, relayer, fmd, wallet: alice, nsk: ALICE_NSK,
            amount: DEPOSIT, rng: aliceRng, auxRng,
        });
    });

    it("first transfer spends alice's note (succeeds)", async () => {
        const bobOut: Note = noteFor(bob, DEPOSIT, bobRng);
        const aliceChange: Note = noteFor(alice, 0n, aliceRng);

        const built = await buildTransfer({
            ...makeBundleCommon(P, J),
            inputs: [await inputSlotFor(P, fmd, aliceNote), null],
            merkleRoot: await currentRoot(fmd),
            outputs: [bobOut, aliceChange],
            outputRecipients: [bob.recipient, alice.recipient],
            outputRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });
        await relayer.submitTransact(built.payload);
        await waitForCm(fmd, built.cm[0]);

        const spentNf = buildNullifierFromNsk(P, ALICE_NSK, aliceNote.note.rho);
        expect(await masp.spent(nfToHex(spentNf))).toBe(true);
    });

    it("replay with same input nullifier reverts", async () => {
        // Same input note + same nsk ⇒ same nullifier. Output randomness
        // is rolled forward, so any revert points squarely at the spent
        // nullifier and not at a cm collision.
        const bobOut: Note = noteFor(bob, DEPOSIT, bobRng);
        const aliceChange: Note = noteFor(alice, 0n, aliceRng);

        // The path may have advanced; refetch via inputSlotFor + use the
        // current root so the proof is otherwise valid. The contract
        // should still reject on the nullifier-already-spent check.
        const built = await buildTransfer({
            ...makeBundleCommon(P, J),
            inputs: [await inputSlotFor(P, fmd, aliceNote), null],
            merkleRoot: await currentRoot(fmd),
            outputs: [bobOut, aliceChange],
            outputRecipients: [bob.recipient, alice.recipient],
            outputRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });

        await expect(relayer.submitTransact(built.payload)).rejects.toThrow();

        // Sanity: the original nullifier remains marked spent.
        const spentNf = buildNullifierFromNsk(P, ALICE_NSK, aliceNote.note.rho);
        expect(await masp.spent(nfToHex(spentNf))).toBe(true);
    });
});
