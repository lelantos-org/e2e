// `wallet.deposit` refuses a `deadline` already in the past before it signs
// (`DEADLINE_PASSED`), so the backdated deadline is submitted through the
// direct path instead.

import { beforeAll, describe, it } from "vitest";

import {
    amt,
    ASSET,
    buildDirectDeposit,
    counter,
    expectRevert,
    type Harness,
    makeWallet,
    newAuxRng,
    REVERT,
    unflushableFee,
    submitDepositDirect,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../../src/harness.js";
import { setupFile } from "../../src/fixture.js";

const { alice: NSK } = TEST_NSK.negExpired;
const DEPOSIT = amt(50n);

describe("negative: expired Permit2 deadline", () => {
    let h: Harness;

    beforeAll(async () => {
        ({ h } = await setupFile({ fund: [{ asset: ASSET, amount: withFee(DEPOSIT) }] }));
    });

    it("deposit reverts when deadline < block.timestamp", async () => {
        // Seeds far apart: `counter` seeds a few apart share most of their draws.
        const rng = counter(0xe1_0001n);
        const auxRng = newAuxRng(0xe1_a000_0001n);
        const alice = makeWallet(h.P, h.J, NSK);
        const built = buildDirectDeposit(h, {
            amount: DEPOSIT,
            recipient: alice.recipient,
            rngs: { rng, auxRng },
            fee: (rngs) => unflushableFee(alice.recipient, rngs),
        });
        // Backdated from the chain's clock, not the host's: Permit2 compares
        // against `block.timestamp`, and anvil's time can run ahead of or behind
        // the wall clock.
        const latest = await h.provider.getBlock("latest");
        if (latest === null) throw new Error("no latest block to backdate the deadline from");
        const deadline = BigInt(latest.timestamp - 60);
        await expectRevert(
            // `maxTotal` is left at its correct default, so the deadline is the
            // only fault.
            submitDepositDirect(h, built, { deadline }),
            REVERT.PERMIT2_EXPIRED,
        );
    }, TEST_TIMEOUT.DEPOSIT);
});
