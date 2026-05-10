// Native ETH unshield flow:
//   1. deposit WETH (asset 1)
//   2. withdrawNative — MASP unwraps WETH, recipient receives raw ETH.
// Asserts recipient ETH balance, MASP WETH balance, accrued WETH fee.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env";
import {
    baseAmt,
    counter,
    deposit,
    type Erc20Helpers,
    feeFor,
    type Harness,
    makeWallet,
    newAuxRng,
    type Note,
    noteFor,
    setupHarness,
    setupWeth,
    snapshotBalances,
    type SpendableCachedNote,
    submitWithdrawNative,
    type TestWallet,
    withFee,
} from "../src/harness";

const ALICE_NSK = 0xee_a1ce_a11c0n;
const ASSET_WETH = 1n;
const DEPOSIT_WETH = 20n;
const WITHDRAW_WETH = 8n;

const DEPOSIT_WETH_BASE = baseAmt(DEPOSIT_WETH, ASSET_WETH);
const WITHDRAW_WETH_BASE = baseAmt(WITHDRAW_WETH, ASSET_WETH);
const SHIELD_FEE = feeFor(DEPOSIT_WETH, ASSET_WETH);
const UNSHIELD_FEE = feeFor(WITHDRAW_WETH, ASSET_WETH);
const NET_WITHDRAW = WITHDRAW_WETH_BASE - UNSHIELD_FEE;

interface Snapshot {
    payerWeth: bigint;
    maspWeth: bigint;
    recipientWeth: bigint;
    recipientEth: bigint;
}

describe("withdraw native ETH (WETH unwrap)", () => {
    let h: Harness;
    let alice: TestWallet;
    let weth: Erc20Helpers;
    let baseline: Snapshot;
    let spendable: SpendableCachedNote;

    const rng = counter(0xee_a1ce_0001n);
    const auxRng = newAuxRng(0xee_add_0001n);

    const WETH_ADDRS = {
        payer: env.payerAddress,
        masp: env.maspAddress,
        recipient: env.recipientAddress,
    };

    async function snap(): Promise<Snapshot> {
        const w = await snapshotBalances(weth, WETH_ADDRS);
        return {
            payerWeth: w.payer,
            maspWeth: w.masp,
            recipientWeth: w.recipient,
            recipientEth: await h.provider.getBalance(env.recipientAddress),
        };
    }

    beforeAll(async () => {
        h = await setupHarness();
        alice = makeWallet(h.P, h.J, ALICE_NSK);
        weth = await setupWeth(h.payer, env.token1, env.permit2Address, withFee(DEPOSIT_WETH, ASSET_WETH));
        baseline = await snap();
    });

    it("deposit WETH (shield leg)", async () => {
        spendable = await deposit({
            h,
            wallet: alice,
            nsk: ALICE_NSK,
            amount: DEPOSIT_WETH,
            rng,
            auxRng,
            asset: ASSET_WETH,
            tokenAddr: env.token1,
        });
        const cur = await snap();
        expect(cur.payerWeth - baseline.payerWeth).toBe(-(DEPOSIT_WETH_BASE + SHIELD_FEE));
        expect(cur.maspWeth - baseline.maspWeth).toBe(DEPOSIT_WETH_BASE + SHIELD_FEE);
    });

    it("withdrawNative — recipient receives raw ETH (no WETH delta)", async () => {
        const before = await snap();

        const remaining = spendable.note.value - WITHDRAW_WETH;
        const change0: Note = noteFor(alice, remaining, rng, ASSET_WETH);
        const change1: Note = noteFor(alice, 0n, rng, ASSET_WETH);

        await submitWithdrawNative({
            h,
            input: spendable,
            publicOut: WITHDRAW_WETH,
            change: [change0, change1],
            changeRecipient: alice,
            auxRng,
            asset: ASSET_WETH,
        });

        const cur = await snap();

        // Recipient gained `NET_WITHDRAW` in raw ETH; WETH balance untouched.
        expect(cur.recipientEth - before.recipientEth).toBe(NET_WITHDRAW);
        expect(cur.recipientWeth - before.recipientWeth).toBe(0n);

        // MASP unwrapped `NET_WITHDRAW` of WETH; the fee remains as WETH in
        // the contract (accrued for the treasury).
        expect(before.maspWeth - cur.maspWeth).toBe(NET_WITHDRAW);

        // Cached spendable note now points at the change output.
        spendable = { note: change0, nsk: ALICE_NSK, leafIndex: 0 };
        expect(spendable.note.value).toBe(DEPOSIT_WETH - WITHDRAW_WETH);
        expect(spendable.note.asset).toBe(ASSET_WETH);
    });

    it("MASP accrues shield + unshield fees in WETH", async () => {
        const masp = new ethers.Contract(env.maspAddress, [
            "function accruedFee(address) view returns (uint256)",
        ], h.provider);
        const accrued = (await masp.accruedFee(env.token1)) as bigint;
        // Lower bound — anvil + fmd are shared across files.
        expect(accrued).toBeGreaterThanOrEqual(SHIELD_FEE + UNSHIELD_FEE);
    });
});
