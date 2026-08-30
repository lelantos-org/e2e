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
    expectRelayerPaid,
    expectRelayerPaidOnDeposit,
    depositTotal,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const { alice: ALICE_NSK, bob: BOB_NSK } = TEST_NSK.fullFlow;

// Sized with room for the relayer's shielded fee on each spend leg: the
// transfer and the withdraw each pay one out of the same inputs, so a wallet
// cannot spend its whole balance.
const DEPOSIT = 125n;
const TO_BOB = 60n;
// Since SDK 0.28 the `amount` on a withdraw is the gross leaving the pool —
// `publicOut` — and the protocol fee is skimmed out of it, so the recipient
// receives `publicOut - fee` rather than `amount`.
const WITHDRAW_PUBLIC_OUT = 42n;

describe("masp e2e flow", () => {
    let h: Harness;
    let erc20: Erc20Helpers;
    let alice: SdkWallet;
    let bob: SdkWallet;
    // Leaf count when this file started. Every file shares one anvil and one
    // MASP, so leaf assertions are deltas against this; an absolute count would
    // hold only when this file ran first.
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

    // The three legs form one narrative: the transfer spends the deposit's note
    // and the withdraw spends the transfer's change. Each is a memoised stage
    // rather than an `it` leaving state for its siblings, so any single `it` can
    // be run with `-t` and pulls in exactly the prefix it needs.

    const deposited = once(async () => {
        const before = await snapshotBalances(erc20);
        const phases: DepositPhase[] = [];
        const r = await alice.deposit({
            amount: amt(DEPOSIT),
            asset: ASSET,
            onPhase: (p) => phases.push(p),
        });
        await awaitOwn(alice, r);
        // What the deposit escrowed for the relayer, read from its own event,
        // and confirmed to have reached it: the payer is debited on top of
        // principal + fee either way, even for a leaf no relayer can open.
        const relayerFee = await expectRelayerPaidOnDeposit(h.provider, r.txHash, ASSET);
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
        return {
            before,
            phases,
            fee: await expectRelayerPaid(r, ASSET),
            leaves: await leavesSinceStart(),
        };
    });

    const withdrawn = once(async () => {
        await transferred();
        const before = await snapshotBalances(erc20);
        const r = await alice.withdraw({
            to: env.recipientAddress,
            amount: amt(WITHDRAW_PUBLIC_OUT),
            asset: ASSET,
        });
        await awaitOwn(alice, r);
        return {
            before,
            fee: await expectRelayerPaid(r, ASSET),
            leaves: await leavesSinceStart(),
        };
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
        // whoever flushes the batch. Only the first is hers, which is why her
        // balance above is the full deposit.
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
        expect(leaves, "leaves after deposit + transfer").toBe(
            LEAVES_PER_DEPOSIT + BigInt(N_OUT),
        );
    }, TEST_TIMEOUT.SPEND);

    it("withdraw: alice unshields 42 (gross) to a public address", async () => {
        const { before, fee, leaves } = await withdrawn();
        const { fee: transferFee } = await transferred();

        // The contract fee applies to publicOut*scale, so the recipient
        // receives publicOut*scale*(1-feeBps).
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
        // `Wallet.deposit` computes maxTotal internally, so the direct path is
        // used to force an undersized one. The pool asks Permit2 for principal
        // + fee while the payer signed for the principal alone, so Permit2
        // rejects the transfer as exceeding the permitted amount.
        const aliceRng = counter(0xff_a1ce_0099n);
        const auxRng = newAuxRng(0xff_add_0099n);
        const aliceKeys = makeWallet(h.P, h.J, ALICE_NSK);
        const built = buildDeposit({
            P: h.P,
            J: h.J,
            chainId: env.chainId,
            asset: ASSET,
            payerAddress: env.payerAddress,
            recipientAddress: env.recipientAddress,
            publicIn: 50n,
            recipient: aliceKeys.recipient,
            output0: { rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng(), rcvDep: aliceRng(), aux: rngForOutput(auxRng) },
            fee: unflushableFee(aliceKeys.recipient, { rng: aliceRng, auxRng }),
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
        // Both legs are deployed at the same rate (`stack.ts` sets
        // MASP_DEPOSIT_BPS and MASP_WITHDRAW_BPS alike), which is what lets
        // `feeFor` be one function rather than two.
        const [depositBps, withdrawBps] = await h.masp.assetFees(ASSET);
        expect(depositBps).toBe(FEE_BPS);
        expect(withdrawBps).toBe(FEE_BPS);
        expect((await h.masp.treasury()) as string).not.toBe(ethers.ZeroAddress);
        // Lower bound: `accruedFee` is cumulative and the MASP is shared, so
        // other files depositing asset 2 raise it.
        expect(await accruedFee(h.provider, env.token2))
            .toBeGreaterThanOrEqual(feeFor(DEPOSIT) + feeFor(WITHDRAW_PUBLIC_OUT));
    });

    it("client sync: fresh wallet recovers bob's 60-unit balance", async () => {
        await transferred();
        // A fresh in-process wallet for bob, with an empty note store: `sync()`
        // must pull, trial-decrypt and surface the 60-unit note for asset 2.
        const bobFresh = await createTestWallet(BOB_NSK);
        await bobFresh.sync({ limit: SYNC_LIMIT });
        expect(bobFresh.balance(ASSET)).toBe(TO_BOB);
    }, TEST_TIMEOUT.LOCAL);
});
