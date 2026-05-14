// SDK Wallet clamps deadline to `now+3600`; use direct-submit to backdate.

import { buildDeposit } from "@lelantos-org/sdk";
import { beforeAll, describe, it } from "vitest";

import { env } from "../../src/env.js";
import {
    ASSET,
    baseAmt,
    counter,
    expectRevert,
    fundPayerForAsset,
    type Harness,
    makeWallet,
    newAuxRng,
    rngForOutput,
    setupHarness,
    submitIntentDirect,
    TEST_NSK,
    withFee,
} from "../../src/harness.js";
import { expiredPermitDeadline } from "../../src/negative.js";

const { alice: NSK } = TEST_NSK.negExpired;

describe("negative: expired Permit2 deadline", () => {
    let h: Harness;

    beforeAll(async () => {
        h = await setupHarness();
        await fundPayerForAsset(h, ASSET, withFee(50n));
    });

    it("submitIntent reverts when deadline < block.timestamp", async () => {
        const rng = counter(0xe1_0001n);
        const aux = newAuxRng(0xe1_0002n);
        const alice = makeWallet(h.P, h.J, NSK);
        const built = buildDeposit({
            ...h.bundleCommon(ASSET),
            publicIn: 50n,
            recipient: alice.recipient,
            output0: {
                rho: rng(), rcm: rng(), rcv: rng(), rcvDep: rng(),
                aux: rngForOutput(aux),
            },
            output1Pad: { rho: rng(), rcm: rng(), rcv: rng(), rcvDep: rng() },
        });
        await expectRevert(
            submitIntentDirect({
                payer: h.payer,
                intent: built.intent,
                aux: built.aux,
                tokenAddr: env.token2,
                maxTotal: baseAmt(50n) + (baseAmt(50n) * 500n) / 10000n,
                deadline: expiredPermitDeadline(),
            }),
            /SignatureExpired|expired|deadline/i,
        );
    }, 240_000);
});
