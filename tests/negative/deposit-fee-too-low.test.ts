// A deposit the relayer will not flush because its fee leaf does not pay it.
//
// `flushBatch` is permissionless, so an unpaid deposit is never rejected
// outright: the relayer leaves it escrowed and reconsiders it every tick
// (`Verdict::Skip` in `deposit_preflight.rs`), and the payer either finds a
// relayer it does pay or cancels. The two ways to under-pay are covered here:
//
//   * the fee note is addressed elsewhere, so this relayer cannot decrypt it
//     ("fee note is not addressed to this relayer")
//   * the fee note is ours but worth less than the flush costs
//     ("fee note does not cover the flush")
//
// `deposit_preflight.rs` unit-tests that decision table; what this file adds is
// that the whole stack acts on it — the note never enters the tree, the funds
// stay escrowed, and the skip is a decision about one deposit rather than a
// stalled relayer.
//
// The control deposit is what makes that last part assertable. Rather than
// waiting a fixed number of ticks and calling silence a pass, a fully-paid
// deposit is submitted alongside the underpaid one and waited on: once it
// lands, a tick has drained a pending set that held both.
//
// The short note is worth zero rather than one unit under the quote. The stub
// oracle prices a flush at one or two circuit units (`config/oracle/README.md`)
// and the relayer re-derives the requirement at flush time under a grace band,
// so "one under the quote" is routinely still enough and the assertion would
// turn on rounding. Zero is short of any positive requirement; the exact
// boundary is a unit test's job.
//
// Each case cancels its skipped deposits before returning, and an
// `EscrowJanitor` cancels whatever a failed assertion left behind: the suite
// shares one stack, and an escrowed deposit left behind is one the relayer keeps
// reconsidering for the rest of the run.
//
// One of those cancels goes through `wallet.cancelDeposit({ depositId,
// fromBlock })` rather than the raw ABI, so the escrow the pool dropped at
// submit is rebuilt from its `DepositEscrowed` log. That is the only way out for
// a payer who kept the id and not the deposit result, and this file is where it
// belongs: it is the one that deliberately creates escrows nothing will flush.
//
// The last case is the one that pins the relayer's liveness. `pop_pending`
// orders oldest-first, so deposits the relayer declines sit at the head of the
// batch window; it defers them and scans past them
// (`services::pipeline::deposit_failures`), and without that a full window of
// them fills the batch and no later deposit on the chain ever flushes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "../../src/env.js";
import {
    amt,
    ASSET,
    buildDirectDeposit,
    cancelDepositAfterDelay,
    type CircuitWallet,
    counter,
    createTestWallet,
    depositTotal,
    EscrowJanitor,
    escrowOf,
    findIndexedNote,
    type Harness,
    isEscrowed,
    makeWallet,
    mineIfAnvil,
    newAuxRng,
    quoteDepositFee,
    relayerFeeNote,
    submitDepositDirect,
    TEST_NSK,
    TEST_TIMEOUT,
    unflushableFee,
    waitForBatchFlushTx,
    waitForCm,
    withFee,
} from "../../src/harness.js";
import { setupFile, type SdkWallet } from "../../src/fixture.js";

const { alice: ALICE_NSK } = TEST_NSK.negDepositFee;
const DEPOSIT = amt(10n);
// Two cases of one skipped deposit and a control, then five more for the
// head-of-window case: a full window of four blocking deposits and one payer.
const DEPOSITS = 9n;

/** How the deposit's fee leaf fails to pay this relayer. */
type Underpayment = "addressed elsewhere" | "worth nothing";

describe("negative: deposit whose fee note does not pay the relayer", () => {
    let h: Harness;
    let alice: CircuitWallet;
    /**
     * An SDK wallet on the same key, for the one cancel that goes through
     * `wallet.cancelDeposit` rather than the raw ABI.
     *
     * Never used to deposit — that is exactly what `setupFile` is given no
     * `nsks` for — but the cancel path is the payer's, and the payer here is the
     * wallet's own EOA, so the refund lands in the same account either way.
     */
    let payerWallet: SdkWallet;
    let janitor: EscrowJanitor | undefined;
    const rng = counter(0xe3_a1ce_0001n);
    const auxRng = newAuxRng(0xe3_add_0001n);

    beforeAll(async () => {
        // No `nsks`: the SDK wallet prices its fee note off
        // `/v1/deposit/estimate` and would always pay it, so these deposits go
        // through the direct `buildDirectDeposit` path with a raw key bundle.
        ({ h } = await setupFile({
            // `fundPayerForAsset` adds the relayer-fee headroom on top.
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT * DEPOSITS) }],
        }));
        alice = makeWallet(h.P, h.J, ALICE_NSK);
        payerWallet = await createTestWallet(ALICE_NSK);
        janitor = new EscrowJanitor(h);
    });

    afterAll(() => janitor?.drain());

    /**
     * Build one deposit of `DEPOSIT` and submit it, paying `feeValue` to the
     * relayer, or nothing to anyone when `fee` is an `Underpayment`.
     *
     * Serial by construction: every call draws from the shared counters in a
     * fixed order, so interleaving two builds makes reruns diverge.
     *
     * An underpaying deposit is handed to the janitor as soon as it lands, so
     * a failed assertion before the case's own cancel cannot strand it.
     */
    async function submit(fee: bigint | Underpayment) {
        // A note addressed to Alice is one the relayer decrypts as `NotOurs`;
        // one addressed to the relayer and worth nothing is ours and short.
        const feeValue = typeof fee === "bigint" ? fee : 0n;
        const built = buildDirectDeposit(h, {
            amount: DEPOSIT,
            recipient: alice.recipient,
            rngs: { rng, auxRng },
            fee: (rngs) => fee === "addressed elsewhere"
                ? unflushableFee(alice.recipient, rngs)
                : relayerFeeNote(h.J, feeValue, rngs),
        });
        // Permit2 signs over what the pool will actually pull (the default
        // `maxTotal`), so an underpaying deposit permits less rather than
        // over-permitting and hiding a wrong charge.
        const r = await submitDepositDirect(h, built);
        if (typeof fee !== "bigint") janitor?.track(r.txHash);
        return { ...r, cm: built.cm, feeValue };
    }

    /**
     * Cancel an escrowed deposit and assert the refund is the whole debit: no
     * leaf was minted, so the relayer fee was never earned either.
     */
    async function cancelAndExpectRefund(d: Awaited<ReturnType<typeof submit>>) {
        const { refunded } = await cancelDepositAfterDelay(h, d.txHash);
        expect(refunded, `refund of deposit ${d.depositId}`).toBe(depositTotal(DEPOSIT, d.feeValue));
        expect(await isEscrowed(h.provider, d.depositId), "cancel cleared the escrow slot").toBe(false);
    }

    /**
     * The same cancel, through `wallet.cancelDeposit({ depositId, fromBlock })`.
     *
     * The escrow object is deliberately not passed: the pool drops the digest
     * preimage at submit, so this path makes the SDK rebuild every cancel
     * argument from the `DepositEscrowed` log alone
     * (`sdk/src/wallet/ops/cancel-deposit.ts:52-72`). That is the recovery a
     * payer who lost the deposit result has, and a wrong rebuild reverts
     * `DigestMismatch` rather than refunding someone else.
     *
     * `fromBlock` is the test's own starting block: the SDK's default look-back
     * is the tip minus the cancel delay and a margin, and the delay here is
     * mined through rather than waited out, so the tip is far past the log.
     */
    async function cancelViaSdkFromLogs(
        d: Awaited<ReturnType<typeof submit>>,
        fromBlock: number,
    ): Promise<void> {
        // The SDK sends as soon as it is asked, so the cancel block has to be
        // reached first; `cancelDepositAfterDelay` does this for the raw path.
        const escrow = await escrowOf(h.provider, d.txHash);
        const behind = escrow.cancellableAtBlock - (await h.provider.getBlockNumber());
        if (behind > 0) await mineIfAnvil(h.provider, behind);

        const c = await payerWallet.cancelDeposit({
            depositId: d.depositId,
            fromBlock: BigInt(fromBlock),
        });
        expect(c.depositId).toBe(d.depositId);
        expect(c.native, "an ERC-20 escrow, cancelled on the pool itself").toBe(false);
        expect(c.refunded.asset).toBe(ASSET);
        // The same figure the raw path asserts: no leaf was minted, so the whole
        // debit comes back, the relayer's unearned note included.
        expect(c.refunded.baseUnits, `refund of deposit ${d.depositId}`)
            .toBe(depositTotal(DEPOSIT, d.feeValue));
        // The fee note is in the deposit's own asset, so it rides in `refunded`
        // and the pool's two-token path is not taken.
        expect(c.feeRefunded, "no second token to refund").toBeNull();
        expect(await isEscrowed(h.provider, d.depositId), "cancel cleared the escrow slot").toBe(false);
    }

    /**
     * Submit `fee`'s deposit, prove the relayer ticked past it by flushing a
     * paying deposit submitted just after, then cancel it.
     */
    async function skippedAlongsideAPayingDeposit(fee: Underpayment) {
        const startBlock = await h.provider.getBlockNumber();
        const required = await quoteDepositFee(h.relayer, env.chainId, ASSET);
        // A relayer that charges nothing flushes everything, and the assertions
        // below would pass for the wrong reason.
        expect(required, "relayer must charge for a flush").toBeGreaterThan(0n);

        const skipped = await submit(fee);
        const paid = await submit(required);

        // Flushed and indexed: from here, "not flushed" is a decision the
        // relayer took about `skipped` while it was pending.
        await waitForBatchFlushTx(h, { fromBlock: startBlock, wantedIds: [paid.depositId] });
        await waitForCm(h.fmd, paid.cm);

        expect(
            await isEscrowed(h.provider, skipped.depositId),
            `a fee note ${fee} was flushed although the relayer quoted ${required}`,
        ).toBe(true);
        // Both leaves enter the tree in the flush the relayer declined to do,
        // so an indexed note would mean it was flushed after all. The whole
        // index is scanned: `paid` is indexed, so a note flushed with it would
        // be too, wherever its row falls.
        expect(
            await findIndexedNote(h.fmd, skipped.cm),
            `the note of a deposit whose fee is ${fee} reached the tree`,
        ).toBeUndefined();

        // The way out, and the reason the next case starts from an empty flush
        // window.
        await cancelAndExpectRefund(skipped);
    }

    it("skips a deposit whose fee note is addressed elsewhere, and the payer cancels it", async () => {
        await skippedAlongsideAPayingDeposit("addressed elsewhere");
    }, TEST_TIMEOUT.SEQUENCE);

    it("skips a deposit whose fee note does not cover the flush, and the payer cancels it", async () => {
        await skippedAlongsideAPayingDeposit("worth nothing");
    }, TEST_TIMEOUT.SEQUENCE);

    it("flushes a paying deposit queued behind enough skipped ones to fill the batch", async () => {
        // `flush_max_n` is clamped to the contract's four deposits per batch
        // (`MAX_L_BATCH = 8` leaves, two per deposit), so four skipped deposits
        // are a full window. They are submitted first and are therefore the
        // oldest pending rows: the relayer reaches the paying deposit only by
        // deferring them and scanning past them.
        const startBlock = await h.provider.getBlockNumber();
        const required = await quoteDepositFee(h.relayer, env.chainId, ASSET);
        const blocking = [
            await submit("addressed elsewhere"),
            await submit("worth nothing"),
            await submit("addressed elsewhere"),
            await submit("worth nothing"),
        ];
        const paid = await submit(required);

        await waitForBatchFlushTx(h, { fromBlock: startBlock, wantedIds: [paid.depositId] });
        await waitForCm(h.fmd, paid.cm);

        for (const [i, b] of blocking.entries()) {
            expect(await isEscrowed(h.provider, b.depositId), "a blocking deposit was flushed").toBe(true);
            // One of them is reclaimed the way a payer who kept only the deposit
            // id would have to: the SDK rebuilds the escrow from the pool's log.
            // The rest go through the raw ABI, which is what pins that the two
            // paths refund the same amount.
            if (i === 0) await cancelViaSdkFromLogs(b, startBlock);
            else await cancelAndExpectRefund(b);
        }
    }, TEST_TIMEOUT.SEQUENCE);
});
