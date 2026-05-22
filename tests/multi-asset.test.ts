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

const { alice: ALICE_NSK } = TEST_NSK.multiAsset;
const { WETH: ASSET_WETH, MDAI: ASSET_MDAI } = ASSETS;
const DEPOSIT_WETH = 10n;
const DEPOSIT_MDAI = 20n;
const WITHDRAW_WETH = 5n;
const WITHDRAW_MDAI = 10n;

describe("multi-asset deposit + withdraw", () => {
    let h: Harness;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;
    let weth: Erc20Helpers;
    let mdai: Erc20Helpers;
    let baselineWeth: Record<string, bigint>;
    let baselineMdai: Record<string, bigint>;

    const TRACKED = {
        payer: env.payerAddress,
        masp: env.maspAddress,
        recipient: env.recipientAddress,
    };
    const snapshot = (t: Erc20Helpers) => snapshotBalances(t, TRACKED);

    beforeAll(async () => {
        h = await setupHarness();
        alice = await createTestWallet(h, ALICE_NSK);
        weth = await fundPayerForAsset(h, ASSET_WETH, withFee(DEPOSIT_WETH, ASSET_WETH));
        mdai = await fundPayerForAsset(h, ASSET_MDAI, withFee(DEPOSIT_MDAI, ASSET_MDAI));
        baselineWeth = await snapshot(weth);
        baselineMdai = await snapshot(mdai);
    });

    // At these magnitudes integer division zeroes the SDK fee, so net delta
    // simplifies to baseAmt(amount) - feeFor(amount).
    const DEPOSIT_WETH_BASE = baseAmt(DEPOSIT_WETH, ASSET_WETH);
    const DEPOSIT_MDAI_BASE = baseAmt(DEPOSIT_MDAI, ASSET_MDAI);
    const WITHDRAW_WETH_BASE = baseAmt(WITHDRAW_WETH, ASSET_WETH);
    const WITHDRAW_MDAI_BASE = baseAmt(WITHDRAW_MDAI, ASSET_MDAI);
    const SHIELD_FEE_WETH = feeFor(DEPOSIT_WETH, ASSET_WETH);
    const SHIELD_FEE_MDAI = feeFor(DEPOSIT_MDAI, ASSET_MDAI);
    const UNSHIELD_FEE_WETH = feeFor(WITHDRAW_WETH, ASSET_WETH);
    const UNSHIELD_FEE_MDAI = feeFor(WITHDRAW_MDAI, ASSET_MDAI);
    const NET_WITHDRAW_WETH = WITHDRAW_WETH_BASE - UNSHIELD_FEE_WETH;
    const NET_WITHDRAW_MDAI = WITHDRAW_MDAI_BASE - UNSHIELD_FEE_MDAI;

    it("deposit 10 WETH", async () => {
        const r = await alice.deposit({ amount: DEPOSIT_WETH, asset: ASSET_WETH });
        await awaitOwn(alice, r);
        const cur = await snapshot(weth);
        expect(cur.payer - baselineWeth.payer).toBe(-(DEPOSIT_WETH_BASE + SHIELD_FEE_WETH));
        expect(cur.masp - baselineWeth.masp).toBe(DEPOSIT_WETH_BASE + SHIELD_FEE_WETH);
        expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT_WETH);
    }, 240_000);

    it("deposit 20 mDAI", async () => {
        const r = await alice.deposit({ amount: DEPOSIT_MDAI, asset: ASSET_MDAI });
        await awaitOwn(alice, r);
        const cur = await snapshot(mdai);
        expect(cur.payer - baselineMdai.payer).toBe(-(DEPOSIT_MDAI_BASE + SHIELD_FEE_MDAI));
        expect(cur.masp - baselineMdai.masp).toBe(DEPOSIT_MDAI_BASE + SHIELD_FEE_MDAI);
        expect(alice.balance(ASSET_MDAI)).toBe(DEPOSIT_MDAI);
    }, 240_000);

    it("withdraw 5 WETH (recipient receives net of unshield fee)", async () => {
        const before = await snapshot(weth);
        const r = await alice.withdraw({ to: env.recipientAddress, amount: WITHDRAW_WETH, asset: ASSET_WETH });
        await awaitOwn(alice, r);
        const cur = await snapshot(weth);
        expect(cur.recipient - before.recipient).toBe(NET_WITHDRAW_WETH);
        expect(before.masp - cur.masp).toBe(NET_WITHDRAW_WETH);
    }, 240_000);

    it("withdraw 10 mDAI (recipient receives net of unshield fee)", async () => {
        const before = await snapshot(mdai);
        const r = await alice.withdraw({ to: env.recipientAddress, amount: WITHDRAW_MDAI, asset: ASSET_MDAI });
        await awaitOwn(alice, r);
        const cur = await snapshot(mdai);
        expect(cur.recipient - before.recipient).toBe(NET_WITHDRAW_MDAI);
        expect(before.masp - cur.masp).toBe(NET_WITHDRAW_MDAI);
    }, 240_000);

    it("balances reconcile across both assets", async () => {
        const w = await snapshot(weth);
        expect(w.payer - baselineWeth.payer).toBe(-(DEPOSIT_WETH_BASE + SHIELD_FEE_WETH));
        expect(w.masp - baselineWeth.masp).toBe(
            (DEPOSIT_WETH_BASE - WITHDRAW_WETH_BASE) + SHIELD_FEE_WETH + UNSHIELD_FEE_WETH,
        );
        expect(w.recipient - baselineWeth.recipient).toBe(NET_WITHDRAW_WETH);

        const m = await snapshot(mdai);
        expect(m.payer - baselineMdai.payer).toBe(-(DEPOSIT_MDAI_BASE + SHIELD_FEE_MDAI));
        expect(m.masp - baselineMdai.masp).toBe(
            (DEPOSIT_MDAI_BASE - WITHDRAW_MDAI_BASE) + SHIELD_FEE_MDAI + UNSHIELD_FEE_MDAI,
        );
        expect(m.recipient - baselineMdai.recipient).toBe(NET_WITHDRAW_MDAI);

        expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT_WETH - WITHDRAW_WETH);
        expect(alice.balance(ASSET_MDAI)).toBe(DEPOSIT_MDAI - WITHDRAW_MDAI);
    });

    it("MASP accrues correct shield + unshield fees per asset", async () => {
        const masp = new ethers.Contract(env.maspAddress, [
            "function accruedFee(address) view returns (uint256)",
        ], h.provider);
        const wethAccrued = (await masp.accruedFee(env.token1)) as bigint;
        const mdaiAccrued = (await masp.accruedFee(env.token2)) as bigint;
        expect(wethAccrued).toBeGreaterThanOrEqual(SHIELD_FEE_WETH + UNSHIELD_FEE_WETH);
        expect(mdaiAccrued).toBeGreaterThanOrEqual(SHIELD_FEE_MDAI + UNSHIELD_FEE_MDAI);
    });
});
