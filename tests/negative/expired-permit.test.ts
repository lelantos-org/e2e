// `Wallet.deposit` clamps the Permit2 deadline to `now + 3600`, so the
// backdated deadline is submitted through the direct path instead.

import { beforeAll, describe, it } from "vitest";

import { env } from "../../src/env.js";
import {
    ASSET,
    buildDeposit,
    counter,
    expectRevert,
    type Harness,
    makeWallet,
    newAuxRng,
    REVERT,
    rngForOutput,
    unflushableFee,
    submitDepositDirect,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../../src/harness.js";
import { setupFile } from "../../src/fixture.js";

const expiredPermitDeadline = () => BigInt(Math.floor(Date.now() / 1000) - 60);

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
            fee: unflushableFee(alice.recipient, { rng, auxRng: aux }),
        });
        await expectRevert(
            submitDepositDirect({
                payer: h.payer,
                deposit: built.deposit,
                aux: built.aux,
                feeAux: built.feeAux,
                tokenAddr: env.token2,
                // Correctly sized, so the deadline is the only fault.
                maxTotal: withFee(50n),
                deadline: expiredPermitDeadline(),
            }),
            REVERT.PERMIT2_EXPIRED,
        );
    }, TEST_TIMEOUT.SPEND);
});
