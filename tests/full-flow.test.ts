// E2E flow: deposit → shielded transfer → withdraw → fmd-driven sync.
// Drives the full stack via the SDK's high-level builders + clients;
// runner-side glue lives in `src/scenario.ts`. Merkle paths are always
// fetched from fmd-webserver — no local tree mirror.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import {
    buildNoteCommitment,
    buildNullifierFromNsk,
    buildTransfer,
    buildWithdraw,
    detectionKeyToHex,
    FmdClient,
    Jubjub,
    type Note,
    Poseidon,
    RelayerClient,
    type SpendableCachedNote,
} from "@lelantos-org/sdk";

import { env } from "../src/env";
import {
    cmToHex,
    counter,
    inputSlotFor,
    MASP_ABI,
    makeWallet,
    nfToHex,
    noteFor,
    rngForOutput,
    setupErc20,
    type TestWallet,
    waitForAdvance,
    waitForCm,
} from "../src/scenario";
import { pollUntil } from "../src/utils";
import {
    currentRoot,
    decryptAndVerifyMatch,
    depositToWallet,
    makeBundleCommon,
    newAuxRng,
    waitForFmdHealth,
} from "./_shared";

const ALICE_NSK = 11n;
const BOB_NSK = 22n;

describe("masp e2e flow", () => {
    let P: Poseidon;
    let J: Jubjub;
    let provider: ethers.JsonRpcProvider;
    let masp: ethers.Contract;
    let relayer: RelayerClient;
    let fmd: FmdClient;
    let erc20: Awaited<ReturnType<typeof setupErc20>>;

    let alice: TestWallet;
    let bob: TestWallet;
    /// Alice's spendable notes. cm is re-derived from `note` inside
    /// `inputSlotFor` when the merkle path is fetched.
    let aliceNotes: SpendableCachedNote[];
    let bobSubscriptionId: number;

    /// Per-test deterministic randomness streams.
    const aliceRng = counter(0xa1n);
    const bobRng = counter(0xb0bn);
    const auxRng = newAuxRng();

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        provider = new ethers.JsonRpcProvider(env.rpcUrl);
        const payer = new ethers.Wallet(env.payerKey, provider);
        masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
        relayer = new RelayerClient(env.relayerUrl);
        fmd = new FmdClient(env.fmdUrl, env.chainId);
        aliceNotes = [];
        erc20 = await setupErc20(payer, env.token2, env.maspAddress, 1000n);

        await waitForFmdHealth();

        alice = makeWallet(P, J, ALICE_NSK);
        bob = makeWallet(P, J, BOB_NSK);
        const sub = await fmd.createSubscription({
            detectionKeyHex: detectionKeyToHex(bob.detectionKey),
            gamma: bob.detectionKey.x.length,
        });
        bobSubscriptionId = sub.id;
    });

    it("deposit: 100 units, alice gets a note", async () => {
        expect(await masp.committedCount()).toBe(0n);

        const payerBefore = await erc20.balanceOf(env.payerAddress);
        const maspBefore = await erc20.balanceOf(env.maspAddress);

        const cached = await depositToWallet({
            P, J, relayer, fmd, wallet: alice, nsk: ALICE_NSK,
            amount: 100n, rng: aliceRng, auxRng,
        });

        // ERC20: payer ↓ 100, MASP ↑ 100.
        expect(payerBefore - (await erc20.balanceOf(env.payerAddress))).toBe(100n);
        expect((await erc20.balanceOf(env.maspAddress)) - maspBefore).toBe(100n);

        // Pad note lands at leaf 1 alongside the real output at leaf 0.
        expect(cached.leafIndex).toBe(0);
        const adv = await waitForAdvance(0);
        expect(adv.inserted).toBe(2);

        aliceNotes.push(cached);

        // /v1/path returns a root the contract recognizes.
        const cm = buildNoteCommitment(P, cached.note);
        const path = await fmd.fetchPath(cmToHex(cm));
        expect(await masp.isKnownRoot("0x" + path.root.toString(16).padStart(64, "0"))).toBe(true);
        expect(await masp.committedCount()).toBe(2n);
    });

    it("shielded transfer: alice sends 60 to bob, keeps 40 change", async () => {
        const aliceCached = aliceNotes[0];

        const bobOut: Note = noteFor(bob, 60n, bobRng);
        const aliceChange: Note = noteFor(alice, 40n, aliceRng);

        const payerBefore = await erc20.balanceOf(env.payerAddress);
        const maspBefore = await erc20.balanceOf(env.maspAddress);
        const recipientBefore = await erc20.balanceOf(env.recipientAddress);

        const built = await buildTransfer({
            ...makeBundleCommon(P, J),
            inputs: [await inputSlotFor(P, fmd, aliceCached), null],
            merkleRoot: await currentRoot(fmd),
            outputs: [bobOut, aliceChange],
            outputRecipients: [bob.recipient, alice.recipient],
            outputRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });
        await relayer.submitTransact(built.payload);

        // Shielded transfer: zero ERC20 movement.
        expect(await erc20.balanceOf(env.payerAddress)).toBe(payerBefore);
        expect(await erc20.balanceOf(env.maspAddress)).toBe(maspBefore);
        expect(await erc20.balanceOf(env.recipientAddress)).toBe(recipientBefore);

        // Bob's cm at leaf 2, Alice's change at leaf 3.
        const indexedBob = await waitForCm(fmd, built.cm[0]);
        const indexedChange = await waitForCm(fmd, built.cm[1]);
        expect(indexedBob.leafIndex).toBe(2);
        expect(indexedChange.leafIndex).toBe(3);
        expect((await waitForAdvance(2)).inserted).toBe(2);

        // Alice swaps her 100 for the 40 change; previous note is spent.
        aliceNotes = [{ note: aliceChange, nsk: ALICE_NSK, leafIndex: indexedChange.leafIndex }];

        // The on-chain spent set picks up Alice's burnt nullifier.
        const spentNf = buildNullifierFromNsk(P, ALICE_NSK, aliceCached.note.rho);
        expect(await masp.spent(nfToHex(spentNf))).toBe(true);
        expect(await masp.committedCount()).toBe(4n);
    });

    it("withdraw: alice unshields 40 to a public address", async () => {
        const aliceCached = aliceNotes[0];
        expect(aliceCached.note.value).toBe(40n);

        const change0: Note = noteFor(alice, 0n, aliceRng);
        const change1: Note = noteFor(alice, 0n, aliceRng);

        const payerBefore = await erc20.balanceOf(env.payerAddress);
        const maspBefore = await erc20.balanceOf(env.maspAddress);
        const recipientBefore = await erc20.balanceOf(env.recipientAddress);

        const built = await buildWithdraw({
            ...makeBundleCommon(P, J),
            inputs: [await inputSlotFor(P, fmd, aliceCached), null],
            merkleRoot: await currentRoot(fmd),
            publicOut: 40n,
            change: [change0, change1],
            changeRecipients: [alice.recipient, alice.recipient],
            changeRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });
        await relayer.submitTransact(built.payload);

        expect((await waitForAdvance(4)).inserted).toBe(2);

        // Withdraw: payer unchanged, MASP ↓ 40, recipient ↑ 40.
        expect(await erc20.balanceOf(env.payerAddress)).toBe(payerBefore);
        expect(maspBefore - (await erc20.balanceOf(env.maspAddress))).toBe(40n);
        expect((await erc20.balanceOf(env.recipientAddress)) - recipientBefore).toBe(40n);

        expect(await masp.committedCount()).toBe(6n);
    });

    it("client sync: bob recovers his 60-unit balance via fmd-webserver", async () => {
        // Bob's filter task should have matched exactly his 60-unit note.
        // Alice's deposit, change, and withdraw pads use Alice's recipient
        // → bob's detection key never hits.
        const matches = await pollUntil(
            async () => {
                const ms = await fmd.listMatches({ subscription: bobSubscriptionId, limit: 50 });
                return ms.length >= 1 ? ms : null;
            },
            { label: "bob matches", timeoutMs: 60_000 },
        );

        expect(matches.length).toBe(1);
        expect(matches[0].leafIndex).toBe(2);

        const { payload } = await decryptAndVerifyMatch(P, J, bob, matches[0]);
        expect(payload.asset).toBe(2n);
        expect(payload.value).toBe(60n);
    });
});
