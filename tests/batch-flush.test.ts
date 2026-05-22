// Asserts the relayer drains N pending IntentEscrowed events into one flushBatch
// tx (IntentFlushed × N + RootAdvanced with inserted = 2*N).

import { buildDeposit, type Field } from "@lelantos-org/sdk";
import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    counter,
    type Harness,
    makeWallet,
    MASP_ABI,
    newAuxRng,
    parseContractLogs,
    rngForOutput,
    setupHarness,
    submitIntentDirect,
    TEST_NSK,
    type TestWallet,
    TIMEOUT,
    waitForBatchFlushTx,
    waitForCm,
    withFee,
} from "../src/harness.js";

const { alice: ALICE_NSK } = TEST_NSK.batchFlush;
const N = 3;
const DEPOSIT_AMT = 10n;

describe("batch flush", () => {
    let h: Harness;
    let alice: TestWallet;
    const aliceRng = counter(0xbf_a1ce_0001n);
    const auxRng = newAuxRng(0xbf_add_0001n);

    beforeAll(async () => {
        h = await setupHarness({
            fund: [{
                kind: "erc20",
                token: env.token2,
                amount: withFee(DEPOSIT_AMT * BigInt(N)),
            }],
        });
        alice = makeWallet(h.P, h.J, ALICE_NSK);
    });

    it(`relayer batches ${N} pending intents into one flushBatch tx`, async () => {
        const startBlock = await h.provider.getBlockNumber();

        // submitIntentDirect awaits its own receipt only; relayer flush is async.
        // Build all N witnesses up-front (rng draws must stay sequential), then
        // fire submits in parallel so all N IntentEscrowed land before the
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
                output1Pad: { rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng(), rcvDep: aliceRng() },
            }),
        );
        // Wrap h.payer in a per-test NonceManager so the N parallel sends
        // get distinct nonces without racing chain.getTransactionCount.
        // (h.payer itself is a plain Wallet — see harness.ts for why.)
        const noncedPayer = new ethers.NonceManager(h.payer);
        const results = await Promise.all(
            builts.map((built) =>
                submitIntentDirect({
                    payer: noncedPayer,
                    intent: built.intent,
                    aux: built.aux,
                    tokenAddr: env.token2,
                    maxTotal: withFee(DEPOSIT_AMT),
                }),
            ),
        );
        const submitted = results.map((r, i) => ({ intentId: r.intentId, cm0: builts[i].cm[0] }));

        const masp = new ethers.Contract(env.maspAddress, MASP_ABI, h.provider);
        const wantedIds = submitted.map((s) => s.intentId);
        const flushTx = await waitForBatchFlushTx({
            provider: h.provider,
            masp,
            maspAddress: env.maspAddress,
            fromBlock: startBlock,
            wantedIds,
        });

        const receipt = await h.provider.getTransactionReceipt(flushTx);
        if (!receipt) throw new Error("flush receipt missing");

        const flushed = parseContractLogs(receipt, masp, "IntentFlushed");
        expect(flushed.length).toBe(N);
        const idsInTx = new Set(flushed.map((l) => (l.args[0] as bigint).toString()));
        expect(idsInTx).toEqual(new Set(wantedIds.map((id) => id.toString())));

        // Each intent contributes 2 cms.
        const rootLogs = parseContractLogs(receipt, masp, "RootAdvanced");
        expect(rootLogs.length).toBe(1);
        expect(rootLogs[0].args.inserted).toBe(BigInt(2 * N));

        for (const s of submitted) {
            await waitForCm(h.fmd, s.cm0);
        }
    }, TIMEOUT.BATCH_FLUSH_TEST_MS);
});
