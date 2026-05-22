import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { baseAmt, feeFor } from "../src/constants.js";
import { env } from "../src/env.js";
import {
    ASSETS,
    createTestWallet,
    type Erc20Helpers,
    fundPayerForAsset,
    type Harness,
    awaitOwn,
    setupHarness,
    snapshotBalances,
    TEST_NSK,
    withFee,
} from "../src/harness.js";

const { alice: ALICE_NSK } = TEST_NSK.withdrawNative;
const ASSET_WETH = ASSETS.WETH;
const DEPOSIT_WETH = 20n;
const WITHDRAW_WETH = 8n;

const DEPOSIT_WETH_BASE = baseAmt(DEPOSIT_WETH, ASSET_WETH);
const WITHDRAW_WETH_BASE = baseAmt(WITHDRAW_WETH, ASSET_WETH);
const SHIELD_FEE = feeFor(DEPOSIT_WETH, ASSET_WETH);
const UNSHIELD_FEE = feeFor(WITHDRAW_WETH, ASSET_WETH);
// SDK fee rounds to 0 at this magnitude, so publicOut == WITHDRAW_WETH.
const NET_WITHDRAW = WITHDRAW_WETH_BASE - UNSHIELD_FEE;

interface Snapshot {
    payerWeth: bigint;
    maspWeth: bigint;
    recipientWeth: bigint;
    recipientEth: bigint;
}

describe("withdraw native ETH (WETH unwrap)", () => {
    let h: Harness;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;
    let weth: Erc20Helpers;
    let baseline: Snapshot;

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
        weth = await fundPayerForAsset(h, ASSET_WETH, withFee(DEPOSIT_WETH, ASSET_WETH));
        alice = await createTestWallet(h, ALICE_NSK);
        baseline = await snap();
    });

    it("deposit WETH (shield leg)", async () => {
        const r = await alice.deposit({ amount: DEPOSIT_WETH, asset: ASSET_WETH });
        await awaitOwn(alice, r);
        const cur = await snap();
        expect(cur.payerWeth - baseline.payerWeth).toBe(-(DEPOSIT_WETH_BASE + SHIELD_FEE));
        expect(cur.maspWeth - baseline.maspWeth).toBe(DEPOSIT_WETH_BASE + SHIELD_FEE);
        expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT_WETH);
    }, 240_000);

    it("withdrawEth — recipient receives raw ETH (no WETH delta)", async () => {
        const before = await snap();
        const r = await alice.withdrawEth({
            to: env.recipientAddress,
            amount: WITHDRAW_WETH,
            asset: ASSET_WETH,
        });
        await awaitOwn(alice, r);

        const cur = await snap();
        expect(cur.recipientEth - before.recipientEth).toBe(NET_WITHDRAW);
        expect(cur.recipientWeth - before.recipientWeth).toBe(0n);
        expect(before.maspWeth - cur.maspWeth).toBe(NET_WITHDRAW);
        expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT_WETH - WITHDRAW_WETH);
    }, 240_000);

    it("MASP accrues shield + unshield fees in WETH", async () => {
        const masp = new ethers.Contract(env.maspAddress, [
            "function accruedFee(address) view returns (uint256)",
        ], h.provider);
        const accrued = (await masp.accruedFee(env.token1)) as bigint;
        expect(accrued).toBeGreaterThanOrEqual(SHIELD_FEE + UNSHIELD_FEE);
    });
});
