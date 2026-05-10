// E2E: relayer batches multiple pending intents into a single
// `flushBatch` tx.
//
// Fires N submitIntent txs back-to-back without waiting for cm
// indexation between them. The relayer's flush cron picks all N pending
// IntentEscrowed events from the DB on its next tick and drains them
// under one batched tree-update SNARK. Asserts:
//   - exactly one tx contains `IntentFlushed × N`
//   - that same tx contains one `RootAdvanced` with `inserted = 2*N`
//
// Other tests serialize on `waitForCm`, which forces actualCount=1 every
// flush. This file is the only one exercising actualCount > 1.

import { buildDeposit, type Field } from "@lelantos-org/sdk";
import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env";
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
    type TestWallet,
    TIMEOUT,
    waitForBatchFlushTx,
    waitForCm,
    withFee,
} from "../src/harness";

const ALICE_NSK = 0xbf_a1ce_a11c0n;
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

        // Fire N submitIntents back-to-back. Each `submitIntentDirect`
        // awaits its OWN receipt only — does not wait for the relayer
        // flush. Relayer accumulates all N in its pending pool, then
        // drains them under one flushBatch.
        const submitted: { intentId: bigint; cm0: Field }[] = [];
        for (let i = 0; i < N; i++) {
            const built = buildDeposit({
                ...h.bundleCommon(),
                publicIn: DEPOSIT_AMT,
                recipient: alice.recipient,
                output0: {
                    rho: aliceRng(),
                    rcm: aliceRng(),
                    rcv: aliceRng(),
                    aux: rngForOutput(auxRng),
                },
                output1Pad: { rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng() },
            });
            const r = await submitIntentDirect({
                payer: h.payer,
                intent: built.intent,
                aux: built.aux,
                tokenAddr: env.token2,
                maxTotal: withFee(DEPOSIT_AMT),
            });
            submitted.push({ intentId: r.intentId, cm0: built.cm[0] });
        }

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

        // Exactly N IntentFlushed events in the single batch tx, each id once.
        const flushed = parseContractLogs(receipt, masp, "IntentFlushed");
        expect(flushed.length).toBe(N);
        const idsInTx = new Set(flushed.map((l) => (l.args[0] as bigint).toString()));
        expect(idsInTx).toEqual(new Set(wantedIds.map((id) => id.toString())));

        // Single RootAdvanced with inserted = 2*N (each intent contributes 2 cms).
        const rootLogs = parseContractLogs(receipt, masp, "RootAdvanced");
        expect(rootLogs.length).toBe(1);
        expect(rootLogs[0].args.inserted).toBe(BigInt(2 * N));

        // All N real-output cms eventually indexed by fmd.
        for (const s of submitted) {
            await waitForCm(h.fmd, s.cm0);
        }
    }, TIMEOUT.BATCH_FLUSH_TEST_MS);
});
