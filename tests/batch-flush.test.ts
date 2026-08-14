// Asserts the relayer drains N pending DepositEscrowed events into one flushBatch
// tx (DepositFlushed × N + RootAdvanced with inserted = N — a deposit occupies
// exactly one leaf now that the zero-value pad output is gone).

import { buildDeposit, type Field } from "@lelantos-org/sdk";
import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    amt,
    ASSET,
    counter,
    type Harness,
    makeWallet,
    MASP_ABI,
    newAuxRng,
    parseContractLogs,
    rngForOutput,
    submitDepositDirect,
    TEST_NSK,
    type CircuitWallet,
    TEST_TIMEOUT,
    TIMEOUT,
    waitForBatchFlushTx,
    waitForCm,
    withFee,
} from "../src/harness.js";
import { setupFile } from "../src/fixture.js";

const { alice: ALICE_NSK } = TEST_NSK.batchFlush;
const N = 3;
const DEPOSIT_AMT = amt(10n);
// `retry: 2` below means up to three attempts, each burning N deposits.
// `beforeAll` does not re-run between retries, so fund for all of them —
// otherwise a retry fails on an empty payer instead of on the thing under test.
const ATTEMPTS = 3n;

describe("batch flush", () => {
    let h: Harness;
    let alice: CircuitWallet;
    const aliceRng = counter(0xbf_a1ce_0001n);
    const auxRng = newAuxRng(0xbf_add_0001n);

    beforeAll(async () => {
        // No `nsks`: this file drives the circuit builders directly rather than
        // the SDK `Wallet`, so it needs a raw key bundle, not a wallet handle.
        ({ h } = await setupFile({
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT_AMT * BigInt(N) * ATTEMPTS) }],
        }));
        alice = makeWallet(h.P, h.J, ALICE_NSK);
    });

    /// Group every `DepositFlushed` since `fromBlock` by the tx that emitted
    /// it. Only used to explain a failure: if the relayer drained the N
    /// intents across two batches, the bare "expected 3, got 2" tells you
    /// nothing, while `tx 0xab… -> [1,2] | tx 0xcd… -> [3]` says exactly that
    /// the submissions straddled a flush tick.
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

    // Retried: the assertion is "one tx drained all N", but the relayer flushes
    // on a fixed 5s tick (config/relayer.toml), so a submission burst that
    // happens to straddle a tick fails on timing rather than on behaviour. A
    // real batching regression fails all three attempts; the grouping in the
    // failure message distinguishes the two.
    it(`relayer batches ${N} pending intents into one flushBatch tx`, {
        retry: 2,
        timeout: TEST_TIMEOUT.BATCH_FLUSH,
    }, async () => {
        const startBlock = await h.provider.getBlockNumber();

        // submitDepositDirect awaits its own receipt only; relayer flush is async.
        // Build all N witnesses up-front (rng draws must stay sequential), then
        // fire submits in parallel so all N DepositEscrowed land before the
        // next 5s flush tick — otherwise the relayer drains them across
        // multiple batches and the "single flushBatch" assertion fails.
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
            }),
        );
        // Wrap h.payer in a per-test NonceManager so the N parallel sends
        // get distinct nonces without racing chain.getTransactionCount.
        // (h.payer itself is a plain Wallet — see harness.ts for why.)
        const noncedPayer = new ethers.NonceManager(h.payer);
        const results = await Promise.all(
            builts.map((built) =>
                submitDepositDirect({
                    payer: noncedPayer,
                    deposit: built.deposit,
                    aux: built.aux,
                    tokenAddr: env.token2,
                    maxTotal: withFee(DEPOSIT_AMT),
                }),
            ),
        );
        const submitted = results.map((r, i) => ({ depositId: r.depositId, cm: builts[i].cm }));

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

        // Each deposit contributes exactly one cm.
        const rootLogs = parseContractLogs(receipt, masp, "RootAdvanced");
        expect(rootLogs.length, "one root advance per flush tx").toBe(1);
        expect(rootLogs[0].args.inserted).toBe(BigInt(N));

        for (const s of submitted) {
            await waitForCm(h.fmd, s.cm);
        }
    });
});
