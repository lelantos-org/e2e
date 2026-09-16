import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import type { DepositPhase, SpendPhase } from "@lelantos-org/sdk";

import { env } from "../src/env.js";
import {
    accruedFee,
    amt,
    ASSET,
    awaitOwn,
    awaitRecipient,
    baseAmt,
    buildDirectDeposit,
    counter,
    createTestWallet,
    type Erc20Helpers,
    expectBalanceDeltas,
    expectRevert,
    FEE_BPS,
    feeFor,
    type Harness,
    LEAVES_PER_DEPOSIT,
    makeWallet,
    N_IN,
    N_OUT,
    netOfGross,
    newAuxRng,
    REVERT,
    snapshotBalances,
    unflushableFee,
    spendItem,
    submitDepositDirect,
    shieldedBalance,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    trackedAddrs,
    expectRelayerPaid,
    expectRelayerPaidOnDeposit,
    depositTotal,
    expectLeafInItem,
    tokenAddressFor,
    waitForBatchFlushTx,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import { TIMEOUT } from "../src/testkit/timeouts.js";

const { alice: ALICE_NSK, bob: BOB_NSK } = TEST_NSK.fullFlow;

// Sized with room for the relayer's shielded fee on each spend leg: the
// transfer and the withdraw each pay one out of the same inputs, so a wallet
// cannot spend its whole balance.
const DEPOSIT = 125n;
const TO_BOB = 60n;
// A withdraw names its `gross`, the `publicOut` leaving the pool, and the
// protocol fee is skimmed out of it, so the recipient receives
// `publicOut - fee` rather than `gross`.
const WITHDRAW_PUBLIC_OUT = 42n;
// Principal of the deposit whose Permit2 ceiling is signed too small.
const UNDERSIZED_PERMIT_AMT = 50n;

describe("masp e2e flow", () => {
    let h: Harness;
    let erc20: Erc20Helpers;
    let alice: SdkWallet;
    let bob: SdkWallet;

    // Leaf assertions read each operation's own item rather than deltas of
    // `committedCount`: the relayer bundles, so a leg can share its transaction
    // (and its block) with operations this file did not make.

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.fullFlow,
            fund: [{ asset: ASSET, amount: withFee(1000n) }],
        });
        ({ h } = f);
        ({ alice, bob } = f.w);
        erc20 = f.token(ASSET);
    });

    // The three legs form one narrative: the transfer spends the deposit's note
    // and the withdraw spends the transfer's change. Each is a memoised stage
    // rather than an `it` leaving state for its siblings, so any single `it` can
    // be run with `-t` and pulls in exactly the prefix it needs.

    const deposited = once(async () => {
        const before = await snapshotBalances(erc20);
        // Opens the window the treasury case asserts over; `withdrawn` closes it.
        const accruedBefore = await accruedFee(h.provider, tokenAddressFor(ASSET).address);
        const fromBlock = await h.provider.getBlockNumber();
        const phases: DepositPhase[] = [];
        const r = await alice.deposit({
            amount: amt(DEPOSIT),
            asset: ASSET,
            onPhase: (p) => phases.push(p),
        });
        await awaitOwn(alice, r);
        // What the deposit escrowed for the relayer, read from its escrow,
        // and confirmed to have reached it: the payer is debited on top of
        // principal + fee either way, even for a leaf no relayer can open.
        const relayerFee = await expectRelayerPaidOnDeposit(r, ASSET);
        // A lookup, not a wait: `awaitOwn` saw the note committed, so its flush
        // is already on chain. A short budget keeps the deposit leg inside
        // `TEST_TIMEOUT.DEPOSIT`.
        const { item } = await waitForBatchFlushTx(h, {
            fromBlock,
            wantedIds: [r.escrow.depositId],
            timeoutMs: TIMEOUT.HTTP_MS,
        });
        return { before, accruedBefore, phases, relayerFee, r, item };
    });

    const transferred = once(async () => {
        await deposited();
        const before = await snapshotBalances(erc20);
        const phases: SpendPhase[] = [];
        const r = await alice.transfer({
            recipient: bob.address,
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
            r,
            item: await spendItem(h.provider, r),
        };
    });

    const withdrawn = once(async () => {
        await transferred();
        const before = await snapshotBalances(erc20);
        const r = await alice.withdraw({
            recipient: env.recipientAddress,
            gross: amt(WITHDRAW_PUBLIC_OUT),
            asset: ASSET,
        });
        await awaitOwn(alice, r);
        return {
            before,
            accruedAfter: await accruedFee(h.provider, tokenAddressFor(ASSET).address),
            fee: await expectRelayerPaid(r, ASSET),
            r,
            item: await spendItem(h.provider, r),
        };
    });

    it("deposit: alice gets a note for the full amount", async () => {
        const { before, phases, relayerFee, r, item } = await deposited();
        expect(phases).toEqual(["preparing", "signing", "submitting", "broadcast", "confirmed"]);

        // Three amounts leave the payer: principal, the pool's protocol fee,
        // and the note paying whoever flushes the batch.
        const moved = depositTotal(DEPOSIT, relayerFee);
        await expectBalanceDeltas(erc20, trackedAddrs(), before, { payer: -moved, masp: moved });

        expect(await shieldedBalance(alice, ASSET)).toBe(DEPOSIT);
        // A deposit occupies two leaves: alice's note and the note paying
        // whoever flushes the batch. Only the first is hers, which is why her
        // balance above is the full deposit. The flush that carried it may
        // carry other deposits, each adding its own two.
        expect(item.kind).toBe("flush");
        expect(item.inserted, "leaves added by the flush").toBe(
            BigInt(LEAVES_PER_DEPOSIT * item.depositIds.length),
        );
        expect(item.cms, "the flush emitted alice's note").toContain(r.commitments[0].toLowerCase());
        expectLeafInItem(alice, r.commitments[0], item);
    }, TEST_TIMEOUT.DEPOSIT);

    it("shielded transfer: alice sends 60 to bob, keeps the rest as change", async () => {
        const { before, phases, fee, r, item } = await transferred();
        expect(phases).toEqual(["preparing", "proving", "submitting", "confirmed"]);

        // A shielded transfer moves no public token at all.
        await expectBalanceDeltas(erc20, trackedAddrs(), before, {
            payer: 0n, masp: 0n, recipient: 0n,
        });

        // The relayer's fee comes out of alice's inputs, not bob's note.
        expect(await shieldedBalance(alice, ASSET)).toBe(DEPOSIT - TO_BOB - fee);
        expect(await shieldedBalance(bob, ASSET)).toBe(TO_BOB);
        expect(item.kind).toBe("transfer");
        expect(item.inserted, "leaves added by the transfer").toBe(BigInt(N_OUT));
        expect(item.nullifiers, "one nullifier per circuit input, padding included").toHaveLength(N_IN);
        expectLeafInItem(bob, r.recipientCommitment, item);
    }, TEST_TIMEOUT.SEQUENCE);

    it("withdraw: alice unshields 42 (gross) to a public address", async () => {
        const { before, fee, r, item } = await withdrawn();
        const { fee: transferFee } = await transferred();

        const recipientNet = netOfGross(WITHDRAW_PUBLIC_OUT);
        await expectBalanceDeltas(erc20, trackedAddrs(), before, {
            payer: 0n,
            masp: -recipientNet,
            recipient: recipientNet,
        });

        // Both spend legs paid the relayer out of alice's own inputs.
        expect(await shieldedBalance(alice, ASSET)).toBe(
            DEPOSIT - TO_BOB - WITHDRAW_PUBLIC_OUT - transferFee - fee,
        );
        expect(item.kind).toBe("withdraw");
        expect(item.inserted, "leaves added by the withdraw").toBe(BigInt(N_OUT));
        expect(item.assetMoved?.publicOut, "the withdraw's own AssetMoved").toBe(WITHDRAW_PUBLIC_OUT);
        for (const cm of r.ownCommitments) expectLeafInItem(alice, cm, item);
    }, TEST_TIMEOUT.SEQUENCE);

    it("deposit reverts when Permit2 maxTotal cannot cover principal + fee", async () => {
        // `wallet.deposit` computes maxTotal internally, so the direct path is
        // used to force an undersized one. The pool asks Permit2 for principal
        // + fee while the payer signed for the principal alone, so Permit2
        // rejects the transfer as exceeding the permitted amount.
        const aliceRng = counter(0xff_a1ce_0099n);
        const auxRng = newAuxRng(0xff_add_0099n);
        const aliceKeys = makeWallet(h.P, h.J, ALICE_NSK);
        const built = buildDirectDeposit(h, {
            amount: UNDERSIZED_PERMIT_AMT,
            recipient: aliceKeys.recipient,
            rngs: { rng: aliceRng, auxRng },
            // Never flushed, and never escrowed either: the submit reverts.
            fee: (rngs) => unflushableFee(aliceKeys.recipient, rngs),
        });
        await expectRevert(
            submitDepositDirect(h, built, {
                // Principal only — short by the protocol fee.
                maxTotal: baseAmt(UNDERSIZED_PERMIT_AMT),
            }),
            REVERT.PERMIT2_INVALID_AMOUNT,
        );
    });

    it("treasury accrues 5% on deposit + withdraw legs", async () => {
        const { accruedBefore } = await deposited();
        const { accruedAfter } = await withdrawn();
        // Both legs are deployed at the same rate (`stack.ts` sets
        // MASP_DEPOSIT_BPS and MASP_WITHDRAW_BPS alike), which is what lets
        // `feeFor` be one function rather than two.
        const [depositBps, withdrawBps] = await h.masp.assetFees(ASSET);
        expect(depositBps).toBe(FEE_BPS);
        expect(withdrawBps).toBe(FEE_BPS);
        expect((await h.masp.treasury()) as string).not.toBe(ethers.ZeroAddress);
        // Exact over the deposit-to-withdraw window: `accruedFee` is cumulative
        // across the shared MASP, but files run serially, and in between this
        // file moves public tokens only on those two legs.
        expect(accruedAfter - accruedBefore, "protocol fee on the deposit and withdraw legs")
            .toBe(feeFor(DEPOSIT) + feeFor(WITHDRAW_PUBLIC_OUT));
    }, TEST_TIMEOUT.SEQUENCE);

    it("client sync: fresh wallet recovers bob's 60-unit balance", async () => {
        await transferred();
        // A fresh in-process wallet for bob, with an empty note store: `sync()`
        // must pull, trial-decrypt and surface the 60-unit note for asset 2.
        const bobFresh = await createTestWallet(BOB_NSK);
        await bobFresh.sync({ pageSize: SYNC_LIMIT });
        expect(await shieldedBalance(bobFresh, ASSET)).toBe(TO_BOB);
    }, TEST_TIMEOUT.SEQUENCE);
});
