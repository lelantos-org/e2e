// SDK Wallet clamps deadline to `now+3600`; use direct-submit to backdate.

import { buildDeposit } from "@lelantos-org/sdk";
import { beforeAll, describe, it } from "vitest";

import { env } from "../../src/env.js";
import {
    ASSET,
    counter,
    expectRevert,
    type Harness,
    makeWallet,
    newAuxRng,
    REVERT,
    rngForOutput,
    submitDepositDirect,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../../src/harness.js";
import { setupFile } from "../../src/fixture.js";
import { expiredPermitDeadline } from "../../src/negative.js";

const { alice: NSK } = TEST_NSK.negExpired;

describe("negative: expired Permit2 deadline", () => {
    let h: Harness;

    beforeAll(async () => {
        ({ h } = await setupFile({ fund: [{ asset: ASSET, amount: withFee(50n) }] }));
    });

    it("deposit reverts when deadline < block.timestamp", async () => {
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
        });
        await expectRevert(
            submitDepositDirect({
                payer: h.payer,
                deposit: built.deposit,
                aux: built.aux,
                tokenAddr: env.token2,
                // Correctly sized, so the only thing wrong is the deadline.
                maxTotal: withFee(50n),
                deadline: expiredPermitDeadline(),
            }),
            REVERT.PERMIT2_EXPIRED,
        );
    }, TEST_TIMEOUT.SPEND);
});
