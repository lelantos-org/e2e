// E2E happy-path: deposit → shielded transfer → withdraw → fmd-driven sync.
// Drives the full stack via the SDK's high-level builders + clients.
// Merkle paths come from fmd-webserver (no local tree mirror).

import { buildDeposit } from "@lelantos-org/sdk";
import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env";
import {
    buildNoteCommitment,
    buildNullifierFromNsk,
    cmToHex,
    baseAmt,
    counter,
    deposit,
    type Erc20Helpers,
    feeFor,
    filterRealMatches,
    type Harness,
    makeWallet,
    newAuxRng,
    nfToHex,
    type Note,
    noteFor,
    pollUntil,
    rngForOutput,
    setupErc20,
    setupHarness,
    type SpendableCachedNote,
    submitIntentDirect,
    submitTransfer,
    submitWithdraw,
    subscribe,
    type TestWallet,
    waitForAdvance,
    withFee,
} from "../src/harness";

const ALICE_NSK = 11n;
const BOB_NSK = 22n;

describe("masp e2e flow", () => {
    let h: Harness;
    let erc20: Erc20Helpers;
    let alice: TestWallet;
    let bob: TestWallet;
    /// Alice's spendable notes. cm is re-derived inside `inputSlotFor`.
    let aliceNotes: SpendableCachedNote[] = [];
    let bobSubscriptionId: number;

    const aliceRng = counter(0xa1n);
    const bobRng = counter(0xb0bn);
    const auxRng = newAuxRng();

    beforeAll(async () => {
        h = await setupHarness();
        erc20 = await setupErc20(h.payer, env.token2, env.permit2Address, withFee(1000n));
        alice = makeWallet(h.P, h.J, ALICE_NSK);
        bob = makeWallet(h.P, h.J, BOB_NSK);
        bobSubscriptionId = await subscribe(h.fmd, bob);
    });

    it("deposit: 100 units, alice gets a note", async () => {
        const initialCount = await h.masp.committedCount();
        expect(initialCount).toBe(0n);

        const payerBefore = await erc20.balanceOf(env.payerAddress);
        const maspBefore = await erc20.balanceOf(env.maspAddress);

        const cached = await deposit({
            h, wallet: alice, nsk: ALICE_NSK, amount: 100n, rng: aliceRng, auxRng,
        });

        // ERC20 deltas in token base-units: principal = publicIn * scale,
        // plus the fee scaled-and-bps'd by `feeFor`.
        const depositFee = feeFor(100n);
        const payerAfter = await erc20.balanceOf(env.payerAddress);
        const maspAfter = await erc20.balanceOf(env.maspAddress);
        expect(payerBefore - payerAfter).toBe(baseAmt(100n) + depositFee);
        expect(maspAfter - maspBefore).toBe(baseAmt(100n) + depositFee);

        // Pad note lands at leaf 1 alongside the real output at leaf 0.
        expect(cached.leafIndex).toBe(0);
        const adv = await waitForAdvance(0);
        expect(adv.inserted).toBe(2);

        aliceNotes.push(cached);

        // /v1/path returns a root the contract recognizes.
        const cm = buildNoteCommitment(h.P, cached.note);
        const path = await h.fmd.fetchPath(cmToHex(cm));
        const rootHex = "0x" + path.root.toString(16).padStart(64, "0");
        const isKnown = await h.masp.isKnownRoot(rootHex);
        expect(isKnown).toBe(true);
        const committedCount = await h.masp.committedCount();
        expect(committedCount).toBe(2n);
    });

    it("shielded transfer: alice sends 60 to bob, keeps 40 change", async () => {
        const aliceCached = aliceNotes[0];
        const bobOut: Note = noteFor(bob, 60n, bobRng);
        const aliceChange: Note = noteFor(alice, 40n, aliceRng);

        const payerBefore = await erc20.balanceOf(env.payerAddress);
        const maspBefore = await erc20.balanceOf(env.maspAddress);
        const recipientBefore = await erc20.balanceOf(env.recipientAddress);

        const built = await submitTransfer({
            h,
            inputs: [aliceCached],
            outputs: [bobOut, aliceChange],
            recipients: [bob, alice],
            auxRng,
        });

        // Shielded transfer: zero ERC20 movement.
        const payerAfter = await erc20.balanceOf(env.payerAddress);
        const maspAfter = await erc20.balanceOf(env.maspAddress);
        const recipientAfter = await erc20.balanceOf(env.recipientAddress);
        expect(payerAfter).toBe(payerBefore);
        expect(maspAfter).toBe(maspBefore);
        expect(recipientAfter).toBe(recipientBefore);

        // Bob's cm at leaf 2, Alice's change at leaf 3.
        const bobPath = await h.fmd.fetchPath(cmToHex(built.cm[0]));
        const changePath = await h.fmd.fetchPath(cmToHex(built.cm[1]));
        expect(bobPath.leafIndex).toBe(2);
        expect(changePath.leafIndex).toBe(3);
        const adv = await waitForAdvance(2);
        expect(adv.inserted).toBe(2);

        // Alice swaps her 100 for the 40 change; previous note is spent.
        aliceNotes = [{ note: aliceChange, nsk: ALICE_NSK, leafIndex: changePath.leafIndex }];

        const spentNf = buildNullifierFromNsk(h.P, ALICE_NSK, aliceCached.note.rho);
        const isSpent = await h.masp.spent(nfToHex(spentNf));
        expect(isSpent).toBe(true);
        const committedCount = await h.masp.committedCount();
        expect(committedCount).toBe(4n);
    });

    it("withdraw: alice unshields 40 to a public address", async () => {
        const aliceCached = aliceNotes[0];
        expect(aliceCached.note.value).toBe(40n);

        const payerBefore = await erc20.balanceOf(env.payerAddress);
        const maspBefore = await erc20.balanceOf(env.maspAddress);
        const recipientBefore = await erc20.balanceOf(env.recipientAddress);

        await submitWithdraw({
            h,
            input: aliceCached,
            publicOut: 40n,
            change: [noteFor(alice, 0n, aliceRng), noteFor(alice, 0n, aliceRng)],
            changeRecipient: alice,
            auxRng,
        });

        const adv = await waitForAdvance(4);
        expect(adv.inserted).toBe(2);

        // Withdraw: recipient receives `outAmt - fee` in base-units; MASP
        // balance drops by the same net.
        const withdrawFee = feeFor(40n);
        const net = baseAmt(40n) - withdrawFee;
        const payerAfter = await erc20.balanceOf(env.payerAddress);
        const maspAfter = await erc20.balanceOf(env.maspAddress);
        const recipientAfter = await erc20.balanceOf(env.recipientAddress);
        const committedCount = await h.masp.committedCount();
        expect(payerAfter).toBe(payerBefore);
        expect(maspBefore - maspAfter).toBe(net);
        expect(recipientAfter - recipientBefore).toBe(net);
        expect(committedCount).toBe(6n);
    });

    it("submitIntent reverts when Permit2 maxTotal cannot cover principal + fee", async () => {
        const principal = 50n;
        const built = buildDeposit({
            ...h.bundleCommon(),
            publicIn: principal,
            recipient: alice.recipient,
            output0: { rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng(), aux: rngForOutput(auxRng) },
            output1Pad: { rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng() },
        });
        // maxTotal = principal-in-base omits the fee; Permit2 reverts when
        // MASP requests `inAmt + fee`. Margin is exactly the fee leg.
        await expect(submitIntentDirect({
            payer: h.payer,
            intent: built.intent,
            aux: built.aux,
            tokenAddr: env.token2,
            maxTotal: baseAmt(principal),
        })).rejects.toThrow();
    });

    it("treasury accrues 5% on deposit + withdraw legs", async () => {
        const view = new ethers.Contract(env.maspAddress, [
            "function accruedFee(address) view returns (uint256)",
            "function feeBps() view returns (uint16)",
            "function treasury() view returns (address)",
        ], h.provider);
        const feeBps = await view.feeBps();
        const treasury = (await view.treasury()) as string;
        expect(feeBps).toBe(500n);
        expect(treasury).not.toBe(ethers.ZeroAddress);
        // Deposit 100 → fee 5; withdraw 40 → fee 2. Lower bound — other
        // test files may have accrued more on the shared anvil.
        const accrued = (await view.accruedFee(env.token2)) as bigint;
        expect(accrued).toBeGreaterThanOrEqual(feeFor(100n) + feeFor(40n));
    });

    it("client sync: bob recovers his 60-unit balance via fmd-webserver", async () => {
        // FMD γ=5 ⇒ ~1/32 false-positive rate per non-recipient ciphertext,
        // so listMatches can return decoys alongside the real one. Filter
        // via decryption before asserting cardinality.
        const real = await pollUntil(
            async () => {
                const ms = await h.fmd.listMatches({ subscription: bobSubscriptionId, limit: 50 });
                const r = filterRealMatches(h.P, h.J, bob, ms);
                return r.length >= 1 ? r : null;
            },
            { label: "bob matches", timeoutMs: 60_000 },
        );
        expect(real.length).toBe(1);
        expect(real[0].leafIndex).toBe(2);
    });
});
