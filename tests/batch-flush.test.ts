// Asserts the relayer drains N pending DepositEscrowed events into one
// flushBatch tx: DepositFlushed × N, and RootAdvanced with inserted = 2N, since
// a deposit occupies two leaves — the depositor's note and the note paying
// whoever flushed it.
//
// N is the contract's ceiling. `MAX_L_BATCH = 4` counts leaves and is pinned by
// the batch circuit's `COUNT_BITS = 2`, so one flush carries at most
// `4 / 2 = 2` deposits. A larger N cannot land in a single tx, and the test
// would then fail on that limit rather than on a regression.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    amt,
    ASSET,
    buildDeposit,
    counter,
    expectRelayerPaidOnCommitment,
    type Harness,
    makeWallet,
    MASP_ABI,
    newAuxRng,
    parseContractLogs,
    rngForOutput,
    quoteDepositFee,
    relayerFeeNote,
    submitDepositDirect,
    TEST_NSK,
    type CircuitWallet,
    TEST_TIMEOUT,
    waitForBatchFlushTx,
    waitForCm,
    depositTotal,
    FEE_HEADROOM,
    withFee,
} from "../src/harness.js";
import { setupFile } from "../src/fixture.js";

const { alice: ALICE_NSK } = TEST_NSK.batchFlush;
const N = 2;
const DEPOSIT_AMT = amt(10n);
// `retry: 2` below allows up to three attempts, each burning N deposits, and
// `beforeAll` does not re-run between them. Funding for all three keeps a retry
// from failing on an empty payer instead of on the behaviour under test.
const ATTEMPTS = 3n;

describe("batch flush", () => {
    let h: Harness;
    let alice: CircuitWallet;
    const aliceRng = counter(0xbf_a1ce_0001n);
    const auxRng = newAuxRng(0xbf_add_0001n);

    beforeAll(async () => {
        // No `nsks`: this file drives the circuit builders directly rather
        // than the SDK `Wallet`, so it needs a raw key bundle.
        ({ h } = await setupFile({
            fund: [
                {
                    asset: ASSET,
                    amount: withFee(DEPOSIT_AMT * BigInt(N) * ATTEMPTS + FEE_HEADROOM),
                },
            ],
        }));
        alice = makeWallet(h.P, h.J, ALICE_NSK);
    });

    /// Group every `DepositFlushed` since `fromBlock` by the tx that emitted
    /// it. Used only to explain a failure: if the relayer drained the N intents
    /// across two batches, a bare "expected 2, got 1" says nothing, while
    /// `tx 0xab… -> [1] | tx 0xcd… -> [2]` shows that the submissions straddled
    /// a flush tick.
    async function flushGrouping(fromBlock: number): Promise<string> {
        const masp = new ethers.Contract(env.maspAddress, MASP_ABI, h.provider);
        const logs = await h.provider.getLogs({
            address: env.maspAddress,
            topics: [masp.interface.getEvent("DepositFlushed")!.topicHash],
            fromBlock,
            toBlock: "latest",
        });
        const byTx = new Map<string, string[]>();
        for (const log of logs) {
            const id = BigInt(log.topics[1]).toString();
            byTx.set(log.transactionHash, [...(byTx.get(log.transactionHash) ?? []), id]);
        }
        return [...byTx].map(([tx, ids]) => `${tx.slice(0, 10)}… -> [${ids}]`).join(" | ");
    }

    // Retried because the relayer flushes on a fixed 5s tick
    // (config/relayer.toml), so a submission burst straddling a tick fails on
    // timing rather than on behaviour. A real batching regression fails all
    // three attempts, and the grouping in the failure message distinguishes the
    // two cases.
    it(`relayer batches ${N} pending intents into one flushBatch tx`, {
        retry: 2,
        timeout: TEST_TIMEOUT.BATCH_FLUSH,
    }, async () => {
        const startBlock = await h.provider.getBlockNumber();

        // `submitDepositDirect` awaits its own receipt only; the relayer flush
        // is asynchronous. All N witnesses are built up front, since rng draws
        // must stay sequential, and the submits then fire in parallel so all N
        // DepositEscrowed land before the next 5s flush tick. One quote covers
        // all N: the amount is per-deposit, and asking once prices every
        // deposit in the batch identically.
        const feeValue = await quoteDepositFee(h.relayer, env.chainId, ASSET);
        const builts = Array.from({ length: N }, () =>
            buildDeposit({
                ...h.bundleCommon(),
                publicIn: DEPOSIT_AMT,
                recipient: alice.recipient,
                output0: {
                    rho: aliceRng(),
                    rcm: aliceRng(),
                    rcv: aliceRng(),
                    rcvDep: aliceRng(),
                    aux: rngForOutput(auxRng),
                },
                // Pays the relayer: this test asserts a flush happens, and a
                // fee note addressed elsewhere is skipped indefinitely.
                fee: relayerFeeNote(h.J, feeValue, { rng: aliceRng, auxRng }),
            }),
        );
        // A per-test `NonceManager` gives the N parallel sends distinct nonces
        // without racing `getTransactionCount`. It opts out of `SerialWallet`'s
        // retry, which would reorder the batch; see `tx.ts`.
        const noncedPayer = new ethers.NonceManager(h.payer);
        const results = await Promise.all(
            builts.map((built) =>
                submitDepositDirect({
                    payer: noncedPayer,
                    deposit: built.deposit,
                    aux: built.aux,
                    feeAux: built.feeAux,
                    tokenAddr: env.token2,
                    maxTotal: depositTotal(DEPOSIT_AMT, feeValue),
                }),
            ),
        );
        const submitted = results.map((r, i) => ({
            depositId: r.depositId,
            cm: builts[i].cm,
            feeCm: builts[i].deposit.feeCm,
        }));

        const masp = new ethers.Contract(env.maspAddress, MASP_ABI, h.provider);
        const wantedIds = submitted.map((s) => s.depositId);
        const flushTx = await waitForBatchFlushTx({
            provider: h.provider,
            masp,
            maspAddress: env.maspAddress,
            fromBlock: startBlock,
            wantedIds,
        }).catch(async (e: Error) => {
            throw new Error(
                `no single tx drained all ${N} intents — flushes seen: ` +
                    `${(await flushGrouping(startBlock)) || "(none)"}`,
                { cause: e },
            );
        });

        const receipt = await h.provider.getTransactionReceipt(flushTx);
        if (!receipt) throw new Error("flush receipt missing");

        const grouping = await flushGrouping(startBlock);
        const flushed = parseContractLogs(receipt, masp, "DepositFlushed");
        expect(flushed.length, `flushes seen: ${grouping}`).toBe(N);
        const idsInTx = new Set(flushed.map((l) => (l.args[0] as bigint).toString()));
        expect(idsInTx, `flushes seen: ${grouping}`)
            .toEqual(new Set(wantedIds.map((id) => id.toString())));

        // Each deposit contributes two leaves, inserted as a single run.
        const rootLogs = parseContractLogs(receipt, masp, "RootAdvanced");
        expect(rootLogs.length, "one root advance per flush tx").toBe(1);
        expect(rootLogs[0].args.inserted).toBe(BigInt(N * 2));

        for (const s of submitted) {
            await waitForCm(h.fmd, s.cm);
            // A flush is only worth doing if it pays: each deposit's second leaf
            // must be a note the relayer can open, which is what the
            // `relayerFeeNote` above is meant to have built.
            await expectRelayerPaidOnCommitment(
                s.feeCm, feeValue, ASSET, `deposit ${s.depositId} fee`,
            );
        }
    });
});
