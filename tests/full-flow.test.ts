import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDeposit } from "@lelantos-org/sdk";
import type { DepositPhase, SpendPhase } from "@lelantos-org/sdk/wallet";

import { env } from "../src/env.js";
import {
    ASSET,
    createTestWallet,
    type Erc20Helpers,
    expectBalanceDeltas,
    feeFor,
    fundPayerForAsset,
    type Harness,
    newAuxRng,
    POLL,
    setupHarness,
    submitIntentDirect,
    TEST_NSK,
    withFee,
} from "../src/harness.js";
import { baseAmt } from "../src/constants.js";
import { makeWallet, rngForOutput, snapshotBalances } from "../src/scenario.js";
import { counter } from "../src/utils.js";

const ADDRS = (): Record<string, string> => ({
    payer: env.payerAddress,
    masp: env.maspAddress,
    recipient: env.recipientAddress,
});

const { alice: ALICE_NSK, bob: BOB_NSK } = TEST_NSK.fullFlow;

describe("masp e2e flow", () => {
    let h: Harness;
    let erc20: Erc20Helpers;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;
    let bob: Awaited<ReturnType<typeof createTestWallet>>;

    beforeAll(async () => {
        h = await setupHarness();
        erc20 = await fundPayerForAsset(h, ASSET, withFee(1000n));
        alice = await createTestWallet(h, ALICE_NSK);
        bob = await createTestWallet(h, BOB_NSK);
    });

    it("deposit: 105 units, alice gets a note", async () => {
        expect(await h.masp.committedCount()).toBe(0n);

        const addrs = ADDRS();
        const before = await snapshotBalances(erc20, addrs);
        const phases: DepositPhase[] = [];
        const r = await alice.deposit({
            amount: 105n,
            asset: ASSET,
            onPhase: (p) => phases.push(p),
        });
        await alice.awaitCommitments(r.commitments, POLL.COMMITMENT);
        expect(phases).toEqual(["signing", "submitting", "broadcast", "mined"]);

        const moved = baseAmt(105n) + feeFor(105n);
        await expectBalanceDeltas(erc20, addrs, before, { payer: -moved, masp: moved });

        expect(await alice.balance(ASSET)).toBe(105n);
        expect(await h.masp.committedCount()).toBe(2n);
    }, 240_000);

    it("shielded transfer: alice sends 60 to bob, keeps 40 change", async () => {
        const addrs = ADDRS();
        const before = await snapshotBalances(erc20, addrs);

        const phases: SpendPhase[] = [];
        const r = await alice.transfer({
            to: bob.address,
            amount: 60n,
            asset: ASSET,
            onPhase: (p) => phases.push(p),
        });
        await alice.awaitCommitments(r.commitments, POLL.SPEND);
        await bob.awaitCommitments(r.commitments, POLL.SPEND);
        expect(phases).toEqual(["preparing", "proving", "submitting"]);

        await expectBalanceDeltas(erc20, addrs, before, { payer: 0n, masp: 0n, recipient: 0n });

        expect(await alice.balance(ASSET)).toBe(45n);
        expect(await bob.balance(ASSET)).toBe(60n);
        expect(await h.masp.committedCount()).toBe(4n);
    }, 240_000);

    it("withdraw: alice unshields 40 (net) to a public address", async () => {
        const addrs = ADDRS();
        const before = await snapshotBalances(erc20, addrs);

        // SDK `amount` is net-to-recipient; publicOut = amount + fee.
        const r = await alice.withdraw({ to: env.recipientAddress, amount: 40n, asset: ASSET });
        await alice.awaitCommitments(r.commitments, POLL.SPEND);

        // Contract fee is on publicOut*scale: recipient = publicOut*scale*(1-feeBps).
        const publicOutBase = baseAmt(42n);
        const onchainFee = (publicOutBase * 500n) / 10000n;
        const recipientNet = publicOutBase - onchainFee;
        await expectBalanceDeltas(erc20, addrs, before, {
            payer: 0n,
            masp: -recipientNet,
            recipient: recipientNet,
        });

        expect(await alice.balance(ASSET)).toBe(3n);
        expect(await h.masp.committedCount()).toBe(6n);
    }, 240_000);

    it("submitIntent reverts when Permit2 maxTotal cannot cover principal + fee", async () => {
        // SDK Wallet computes maxTotal internally; use direct-path helper to
        // force an undersized maxTotal.
        const aliceRng = counter(0xff_a1ce_0099n);
        const auxRng = newAuxRng(0xff_add_0099n);
        const aliceLegacy = makeWallet(h.P, h.J, ALICE_NSK);
        const built = buildDeposit({
            P: h.P,
            J: h.J,
            chainId: env.chainId,
            asset: ASSET,
            payerAddress: env.payerAddress,
            recipientAddress: env.recipientAddress,
            publicIn: 50n,
            recipient: aliceLegacy.recipient,
            output0: { rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng(), rcvDep: aliceRng(), aux: rngForOutput(auxRng) },
            output1Pad: { rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng(), rcvDep: aliceRng() },
        });
        await expect(submitIntentDirect({
            payer: h.payer,
            intent: built.intent,
            aux: built.aux,
            tokenAddr: env.token2,
            maxTotal: baseAmt(50n),
        })).rejects.toThrow();
    });

    it("treasury accrues 5% on deposit + withdraw legs", async () => {
        const view = new ethers.Contract(env.maspAddress, [
            "function accruedFee(address) view returns (uint256)",
            "function feeBps() view returns (uint16)",
            "function treasury() view returns (address)",
        ], h.provider);
        expect(await view.feeBps()).toBe(500n);
        expect((await view.treasury()) as string).not.toBe(ethers.ZeroAddress);
        // Lower bound — other test files may have accrued more on the shared anvil.
        const accrued = (await view.accruedFee(env.token2)) as bigint;
        expect(accrued).toBeGreaterThanOrEqual(feeFor(105n) + feeFor(40n));
    });

    it("client sync: fresh wallet recovers bob's 60-unit balance", async () => {
        // Fresh in-process wallet for bob — empty note store. sync() must
        // pull, trial-decrypt, and surface the 60-unit note for asset 2.
        const bobFresh = await createTestWallet(h, BOB_NSK);
        await bobFresh.sync({ limit: 200 });
        expect(await bobFresh.balance(ASSET)).toBe(60n);
    }, 60_000);
});
