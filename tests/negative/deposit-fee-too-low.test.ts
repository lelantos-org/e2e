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
// Each case cancels its skipped deposit before returning: the suite shares one
// stack, and an escrowed deposit left behind is one the relayer keeps
// reconsidering for the rest of the run.
//
// The last case is the one that pins the relayer's liveness. `pop_pending`
// orders oldest-first, so deposits the relayer declines sit at the head of the
// batch window; it defers them and scans past them
// (`services::pipeline::deposit_failures`), and without that a pair of them
// fills the window and no later deposit on the chain ever flushes.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../../src/env.js";
import {
    amt,
    ASSET,
    baseAmt,
    buildDeposit,
    cancelDepositAfterDelay,
    type CircuitWallet,
    counter,
    depositTotal,
    FEE_HEADROOM,
    feeFor,
    type Harness,
    makeWallet,
    newAuxRng,
    quoteDepositFee,
    relayerFeeNote,
    rngForOutput,
    scaleFor,
    submitDepositDirect,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    unflushableFee,
    waitForBatchFlushTx,
    waitForCm,
    withFee,
} from "../../src/harness.js";
import { setupFile } from "../../src/fixture.js";

const { alice: ALICE_NSK } = TEST_NSK.negDepositFee;
const DEPOSIT = amt(10n);
// Two cases of one skipped deposit and a control, then three more for the
// head-of-window case.
const DEPOSITS = 7n;

/** How the deposit's fee leaf fails to pay this relayer. */
type Underpayment = "addressed elsewhere" | "worth nothing";

describe("negative: deposit whose fee note does not pay the relayer", () => {
    let h: Harness;
    let alice: CircuitWallet;
    const rng = counter(0xe3_a1ce_0001n);
    const auxRng = newAuxRng(0xe3_add_0001n);

    beforeAll(async () => {
        // No `nsks`: the SDK `Wallet` prices its fee note off
        // `/v1/deposit/estimate` and would always pay it, so these deposits go
        // through the direct `buildDeposit` path with a raw key bundle.
        ({ h } = await setupFile({
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT * DEPOSITS + FEE_HEADROOM) }],
        }));
        alice = makeWallet(h.P, h.J, ALICE_NSK);
    });

    /**
     * Build one deposit of `DEPOSIT` and submit it, paying `feeValue` to the
     * relayer, or nothing to anyone when `fee` is an `Underpayment`.
     *
     * Serial by construction: every call draws from the shared counters, and
     * `buildDeposit` consumes them in a fixed order, so interleaving two builds
     * makes reruns diverge.
     */
    async function submit(fee: bigint | Underpayment) {
        // A note addressed to Alice is one the relayer decrypts as `NotOurs`;
        // one addressed to the relayer and worth nothing is ours and short.
        const feeValue = typeof fee === "bigint" ? fee : 0n;
        const built = buildDeposit({
            ...h.bundleCommon(ASSET),
            publicIn: DEPOSIT,
            recipient: alice.recipient,
            output0: {
                rho: rng(), rcm: rng(), rcv: rng(), rcvDep: rng(),
                aux: rngForOutput(auxRng),
            },
            fee: fee === "addressed elsewhere"
                ? unflushableFee(alice.recipient, { rng, auxRng })
                : relayerFeeNote(h.J, feeValue, { rng, auxRng }),
        });
        const r = await submitDepositDirect({
            payer: h.payer,
            deposit: built.deposit,
            aux: built.aux,
            feeAux: built.feeAux,
            tokenAddr: env.token2,
            // Permit2 signs over what the pool will actually pull, so an
            // underpaying deposit permits less rather than over-permitting and
            // hiding a wrong charge.
            maxTotal: depositTotal(DEPOSIT, feeValue),
        });
        return { ...r, cm: built.cm, feeValue };
    }

    /** Nonzero exactly while the deposit is still escrowed; see `MASP.escrowed`. */
    async function stillEscrowed(depositId: bigint): Promise<boolean> {
        return (await h.masp.escrowed(depositId)) !== ethers.ZeroHash;
    }

    async function indexedCms(): Promise<Set<bigint>> {
        const rows = await h.fmd.listNotes({ limit: SYNC_LIMIT });
        return new Set(rows.map((n) => n.cm));
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
        await waitForBatchFlushTx({
            provider: h.provider,
            masp: h.masp,
            maspAddress: env.maspAddress,
            fromBlock: startBlock,
            wantedIds: [paid.depositId],
        });
        await waitForCm(h.fmd, paid.cm);

        expect(
            await stillEscrowed(skipped.depositId),
            `a fee note ${fee} was flushed although the relayer quoted ${required}`,
        ).toBe(true);
        // Both leaves enter the tree in the flush the relayer declined to do,
        // so an indexed note would mean it was flushed after all.
        expect(
            (await indexedCms()).has(skipped.cm),
            `the note of a deposit whose fee is ${fee} reached the tree`,
        ).toBe(false);

        // The way out, and the reason the next case starts from an empty flush
        // window. The refund is the whole debit: no leaf was minted, so the
        // relayer fee was never earned either.
        const { refunded } = await cancelDepositAfterDelay({
            provider: h.provider,
            payer: h.payer,
            maspAddress: env.maspAddress,
            txHash: skipped.txHash,
        });
        expect(refunded).toBe(
            baseAmt(DEPOSIT) + feeFor(DEPOSIT) + skipped.feeValue * scaleFor(ASSET),
        );
        expect(await stillEscrowed(skipped.depositId), "cancel cleared the escrow slot").toBe(false);
    }

    it("skips a deposit whose fee note is addressed elsewhere, and the payer cancels it", async () => {
        await skippedAlongsideAPayingDeposit("addressed elsewhere");
    }, TEST_TIMEOUT.SEQUENCE);

    it("skips a deposit whose fee note does not cover the flush, and the payer cancels it", async () => {
        await skippedAlongsideAPayingDeposit("worth nothing");
    }, TEST_TIMEOUT.SEQUENCE);

    it("flushes a paying deposit queued behind enough skipped ones to fill the batch", async () => {
        // `flush_max_n` is clamped to the contract's two deposits per batch, so
        // two skipped deposits are a full window. They are submitted first and
        // are therefore the oldest pending rows: the relayer reaches the paying
        // deposit only by deferring them and scanning past them.
        const startBlock = await h.provider.getBlockNumber();
        const required = await quoteDepositFee(h.relayer, env.chainId, ASSET);
        const blocking = [await submit("addressed elsewhere"), await submit("worth nothing")];
        const paid = await submit(required);

        await waitForBatchFlushTx({
            provider: h.provider,
            masp: h.masp,
            maspAddress: env.maspAddress,
            fromBlock: startBlock,
            wantedIds: [paid.depositId],
        });
        await waitForCm(h.fmd, paid.cm);

        for (const b of blocking) {
            expect(await stillEscrowed(b.depositId), "a blocking deposit was flushed").toBe(true);
            await cancelDepositAfterDelay({
                provider: h.provider,
                payer: h.payer,
                maspAddress: env.maspAddress,
                txHash: b.txHash,
            });
        }
    }, TEST_TIMEOUT.SEQUENCE);
});
