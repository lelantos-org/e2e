// Asserts the relayer drains N pending DepositEscrowed events into one
// flushBatch call: DepositFlushed × N, and RootAdvanced with inserted = 2N,
// since a deposit occupies two leaves — the depositor's note and the note paying
// whoever flushed it.
//
// The call, not the transaction: the relayer lands operations through its
// Bundler, so a flush can share a transaction with spends or another flush.
// Every assertion reads the flush's own item (`bundleItems`), never
// receipt-wide counts.
//
// N is the contract's ceiling. `MAX_L_BATCH = 8` counts leaves and is pinned by
// the batch circuit's `COUNT_BITS = 3`, so one flush carries at most
// `8 / 2 = 4` deposits. A larger N cannot land in a single tx, and the test
// would then fail on that limit rather than on a regression.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    amt,
    ASSET,
    buildDirectDeposit,
    cmToHex,
    counter,
    expectRelayerPaidOnCommitment,
    FEE_HEADROOM,
    type Harness,
    LEAVES_PER_DEPOSIT,
    makeWallet,
    newAuxRng,
    txBundleItems,
    quoteDepositFee,
    relayerFeeNote,
    submitDepositDirect,
    TEST_NSK,
    type CircuitWallet,
    TEST_TIMEOUT,
    waitForBatchFlushTx,
    waitForCm,
    withFee,
} from "../src/harness.js";
import { setupFile } from "../src/fixture.js";

const { alice: ALICE_NSK } = TEST_NSK.batchFlush;
const N = 4;
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
        // than the SDK wallet, so it needs a raw key bundle.
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

    /// Group every `DepositFlushed` since `fromBlock` by the flush operation
    /// that emitted it. Used only to explain a failure: if the relayer drained
    /// the N intents across two batches, a bare "expected 2, got 1" says
    /// nothing, while `tx 0xab…#0 -> [1] | tx 0xcd…#1 -> [2]` shows that the
    /// submissions straddled a flush tick. The `#k` is the operation's position
    /// in its transaction, so two flushes bundled together read as two groups.
    async function flushGrouping(fromBlock: number): Promise<string> {
        const logs = await h.provider.getLogs({
            address: env.maspAddress,
            topics: [h.masp.interface.getEvent("DepositFlushed")!.topicHash],
            fromBlock,
            toBlock: "latest",
        });
        const groups: string[] = [];
        for (const tx of new Set(logs.map((l) => l.transactionHash))) {
            const { items } = await txBundleItems(h.provider, tx);
            for (const item of items.filter((i) => i.kind === "flush")) {
                groups.push(`${tx.slice(0, 10)}…#${item.index} -> [${item.depositIds}]`);
            }
        }
        return groups.join(" | ");
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
            buildDirectDeposit(h, {
                amount: DEPOSIT_AMT,
                recipient: alice.recipient,
                rngs: { rng: aliceRng, auxRng },
                // Pays the relayer: this test asserts a flush happens, and a
                // fee note addressed elsewhere is skipped indefinitely.
                fee: (r) => relayerFeeNote(h.J, feeValue, r),
            }),
        );
        // A per-test `NonceManager` gives the N parallel sends distinct nonces
        // without racing `getTransactionCount`. It opts out of `SerialWallet`'s
        // retry, which would reorder the batch; see `tx.ts`.
        const noncedPayer = new ethers.NonceManager(h.payer);
        const results = await Promise.all(
            builts.map((built) => submitDepositDirect(h, built, { payer: noncedPayer })),
        );
        const submitted = results.map((r, i) => ({
            depositId: r.depositId,
            cm: builts[i].cm,
            feeCm: builts[i].deposit.feeCm,
        }));

        const wantedIds = submitted.map((s) => s.depositId);
        const { item } = await waitForBatchFlushTx(h, {
            fromBlock: startBlock,
            wantedIds,
        }).catch(async (e: Error) => {
            throw new Error(
                `no single tx drained all ${N} intents — flushes seen: ` +
                    `${(await flushGrouping(startBlock)) || "(none)"}`,
                { cause: e },
            );
        });

        const grouping = await flushGrouping(startBlock);
        expect(item.depositIds.length, `flushes seen: ${grouping}`).toBe(N);
        expect(new Set(item.depositIds.map((id) => id.toString())), `flushes seen: ${grouping}`)
            .toEqual(new Set(wantedIds.map((id) => id.toString())));
        expect(item.cms, "each deposit's own note, in flush order")
            .toEqual(item.depositIds.map((id) => cmToHex(submitted.find((s) => s.depositId === id)!.cm)));

        // Each deposit contributes two leaves, inserted as the flush's own
        // single run: its `RootAdvanced`, not every root the transaction moved.
        expect(item.inserted, "one root advance of 2N leaves for the flush")
            .toBe(BigInt(N * LEAVES_PER_DEPOSIT));

        // In parallel: `BATCH_FLUSH` budgets one indexer wait and one fee-note
        // wait, not N of each.
        await Promise.all(submitted.map(async (s) => {
            await waitForCm(h.fmd, s.cm);
            // A flush is only worth doing if it pays: each deposit's second leaf
            // must be a note the relayer can open, which is what the
            // `relayerFeeNote` above is meant to have built.
            await expectRelayerPaidOnCommitment(
                s.feeCm, feeValue, ASSET, `deposit ${s.depositId} fee`,
            );
        }));
    });
});
