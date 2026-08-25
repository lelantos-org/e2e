import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import type { DepositPhase, SpendPhase } from "@lelantos-org/sdk/wallet";

import { env } from "../src/env.js";
import {
    accruedFee,
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    baseAmt,
    buildDeposit,
    counter,
    createTestWallet,
    type Erc20Helpers,
    expectBalanceDeltas,
    expectRevert,
    FEE_BPS,
    feeFor,
    type Harness,
    makeWallet,
    N_OUT,
    newAuxRng,
    REVERT,
    rngForOutput,
    snapshotBalances,
    unflushableFee,
    submitDepositDirect,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    trackedAddrs,
    depositFeePaid,
    feePaid,
    depositTotal,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const { alice: ALICE_NSK, bob: BOB_NSK } = TEST_NSK.fullFlow;

// Sized with room for the relayer's shielded fee on each spend leg: the
// transfer and the withdraw each pay one, and a wallet can never spend its
// whole balance because the fee note comes out of the same inputs.
const DEPOSIT = 125n;
const TO_BOB = 60n;
// SDK `amount` on a withdraw is net-to-recipient; publicOut = amount + fee.
const WITHDRAW_NET = 40n;
const WITHDRAW_PUBLIC_OUT = 42n;

describe("masp e2e flow", () => {
    let h: Harness;
    let erc20: Erc20Helpers;
    let alice: SdkWallet;
    let bob: SdkWallet;
    // Leaf count when this file started. Every file in the suite shares one
    // anvil and one MASP, so leaf assertions are deltas against this — an
    // absolute count would only hold when this file happened to run first,
    // and vitest orders files differently cold vs. warm-cache.
    let leavesAtStart: bigint;

    /// Mirrors `PubInputs.LEAVES_PER_DEPOSIT`: the depositor's note plus the
    /// note paying whoever flushes it.
    const LEAVES_PER_DEPOSIT = 2n;

    const leavesSinceStart = async (): Promise<bigint> =>
        ((await h.masp.committedCount()) as bigint) - leavesAtStart;

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.fullFlow,
            fund: [{ asset: ASSET, amount: withFee(1000n) }],
        });
        ({ h } = f);
        ({ alice, bob } = f.w);
        erc20 = f.token(ASSET);
        leavesAtStart = (await h.masp.committedCount()) as bigint;
    });

    // The three legs are one narrative: the transfer spends the deposit's note
    // and the withdraw spends the transfer's change. Each is a memoised stage
    // rather than an `it` that leaves state behind for its siblings, so any
    // single `it` can be run with `-t` and pulls in exactly the prefix it needs.

    const deposited = once(async () => {
        const before = await snapshotBalances(erc20);
        const phases: DepositPhase[] = [];
        const r = await alice.deposit({
            amount: amt(DEPOSIT),
            asset: ASSET,
            onPhase: (p) => phases.push(p),
        });
        await awaitOwn(alice, r);
        // What the deposit actually escrowed for the relayer, read from its
        // own event — the payer was debited for it on top of principal + fee.
        const relayerFee = await depositFeePaid(h.provider, env.maspAddress, r.txHash);
        return { before, phases, relayerFee, leaves: await leavesSinceStart() };
    });

    const transferred = once(async () => {
        await deposited();
        const before = await snapshotBalances(erc20);
        const phases: SpendPhase[] = [];
        const r = await alice.transfer({
            to: bob.address,
            amount: amt(TO_BOB),
            asset: ASSET,
            onPhase: (p) => phases.push(p),
        });
        await awaitOwn(alice, r);
        await awaitRecipient(bob, r);
        return { before, phases, fee: feePaid(r), leaves: await leavesSinceStart() };
    });

    const withdrawn = once(async () => {
        await transferred();
        const before = await snapshotBalances(erc20);
        const r = await alice.withdraw({
            to: env.recipientAddress,
            amount: amt(WITHDRAW_NET),
            asset: ASSET,
        });
        await awaitOwn(alice, r);
        return { before, fee: feePaid(r), leaves: await leavesSinceStart() };
    });

    it("deposit: alice gets a note for the full amount", async () => {
        const { before, phases, relayerFee, leaves } = await deposited();
        expect(phases).toEqual(["signing", "submitting", "broadcast", "mined"]);

        // Three amounts leave the payer: principal, the pool's protocol fee,
        // and the note paying whoever flushes the batch.
        const moved = depositTotal(DEPOSIT, relayerFee);
        await expectBalanceDeltas(erc20, trackedAddrs(), before, { payer: -moved, masp: moved });

        expect(alice.balance(ASSET)).toBe(DEPOSIT);
        // A deposit occupies two leaves: alice's note and the note paying
        // whoever flushed the batch. Only the first is alice's, which is why
        // her balance above is the full deposit and not a leaf count.
        expect(leaves, "leaves added by the deposit").toBe(LEAVES_PER_DEPOSIT);
    }, TEST_TIMEOUT.SPEND);

    it("shielded transfer: alice sends 60 to bob, keeps the rest as change", async () => {
        const { before, phases, fee, leaves } = await transferred();
        expect(phases).toEqual(["preparing", "proving", "submitting"]);

        // A shielded transfer moves no public token at all.
        await expectBalanceDeltas(erc20, trackedAddrs(), before, {
            payer: 0n, masp: 0n, recipient: 0n,
        });

        // The relayer's fee comes out of alice's inputs, not bob's note.
        expect(alice.balance(ASSET)).toBe(DEPOSIT - TO_BOB - fee);
        expect(bob.balance(ASSET)).toBe(TO_BOB);
        // 1 deposit leaf + N_OUT spend leaves.
        expect(leaves, "leaves after deposit + transfer").toBe(
            LEAVES_PER_DEPOSIT + BigInt(N_OUT),
        );
    }, TEST_TIMEOUT.SPEND);

    it("withdraw: alice unshields 40 (net) to a public address", async () => {
        const { before, fee, leaves } = await withdrawn();
        const { fee: transferFee } = await transferred();

        // Contract fee is on publicOut*scale: recipient = publicOut*scale*(1-feeBps).
        const recipientNet = baseAmt(WITHDRAW_PUBLIC_OUT) - feeFor(WITHDRAW_PUBLIC_OUT);
        await expectBalanceDeltas(erc20, trackedAddrs(), before, {
            payer: 0n,
            masp: -recipientNet,
            recipient: recipientNet,
        });

        // Both spend legs paid the relayer out of alice's own inputs.
        expect(alice.balance(ASSET)).toBe(
            DEPOSIT - TO_BOB - WITHDRAW_PUBLIC_OUT - transferFee - fee,
        );
        expect(leaves, "leaves after deposit + transfer + withdraw").toBe(
            LEAVES_PER_DEPOSIT + BigInt(2 * N_OUT),
        );
    }, TEST_TIMEOUT.SPEND);

    it("deposit reverts when Permit2 maxTotal cannot cover principal + fee", async () => {
        // SDK Wallet computes maxTotal internally; use the direct-path helper to
        // force an undersized one. The pool asks Permit2 for principal + fee but
        // the payer only signed for the principal, so Permit2 rejects the
        // transfer as exceeding the permitted amount.
        const aliceRng = counter(0xff_a1ce_0099n);
        const auxRng = newAuxRng(0xff_add_0099n);
        const aliceLegacy = makeWallet(h.P, h.J, ALICE_NSK);
        const built = buildDeposit({
            P: h.P,
            J: h.J,
            chainId: env.chainId,
            asset: ASSET,
            payerAddress: env.payerAddress,
            recipientAddress: env.recipientAddress,
            publicIn: 50n,
            recipient: aliceLegacy.recipient,
            output0: { rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng(), rcvDep: aliceRng(), aux: rngForOutput(auxRng) },
            fee: unflushableFee(aliceLegacy.recipient, { rng: aliceRng, auxRng }),
        });
        await expectRevert(
            submitDepositDirect({
                payer: h.payer,
                deposit: built.deposit,
                aux: built.aux,
                feeAux: built.feeAux,
                tokenAddr: env.token2,
                maxTotal: baseAmt(50n), // principal only — short by the fee
            }),
            REVERT.PERMIT2_INVALID_AMOUNT,
        );
    });

    it("treasury accrues 5% on deposit + withdraw legs", async () => {
        await withdrawn();
        const view = new ethers.Contract(env.maspAddress, [
            "function feeBps() view returns (uint16)",
            "function treasury() view returns (address)",
        ], h.provider);
        expect(await view.feeBps()).toBe(FEE_BPS);
        expect((await view.treasury()) as string).not.toBe(ethers.ZeroAddress);
        // Lower bound: `accruedFee` is cumulative and the MASP is shared, so
        // other files depositing asset 2 raise it.
        expect(await accruedFee(h.provider, env.token2))
            .toBeGreaterThanOrEqual(feeFor(DEPOSIT) + feeFor(WITHDRAW_PUBLIC_OUT));
    });

    it("client sync: fresh wallet recovers bob's 60-unit balance", async () => {
        await transferred();
        // Fresh in-process wallet for bob — empty note store. sync() must
        // pull, trial-decrypt, and surface the 60-unit note for asset 2.
        const bobFresh = await createTestWallet(BOB_NSK);
        await bobFresh.sync({ limit: SYNC_LIMIT });
        expect(bobFresh.balance(ASSET)).toBe(TO_BOB);
    }, TEST_TIMEOUT.LOCAL);
});
