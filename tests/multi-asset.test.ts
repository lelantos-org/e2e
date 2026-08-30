import { beforeAll, describe, expect, it } from "vitest";

import type { AssetId, CircuitAmount } from "@lelantos-org/sdk";

import { env } from "../src/env.js";
import {
    accruedFee,
    amt,
    ASSETS,
    awaitOwn,
    baseAmt,
    expectRelayerPaid,
    expectRelayerPaidOnDeposit,
    scaleFor,
    feeFor,
    type Erc20Helpers,
    type Harness,
    snapshotBalances,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

const { WETH: ASSET_WETH, MDAI: ASSET_MDAI } = ASSETS;
const DEPOSIT_WETH = amt(10n);
const DEPOSIT_MDAI = amt(20n);
const WITHDRAW_WETH = amt(5n);
const WITHDRAW_MDAI = amt(10n);

// Since SDK 0.28 the withdraw `amount` is the gross leaving the pool, so
// publicOut == the amount passed and the net delta is
// baseAmt(amount) - feeFor(amount).
const SHIELD_FEE_WETH = feeFor(DEPOSIT_WETH, ASSET_WETH);
const SHIELD_FEE_MDAI = feeFor(DEPOSIT_MDAI, ASSET_MDAI);
const UNSHIELD_FEE_WETH = feeFor(WITHDRAW_WETH, ASSET_WETH);
const UNSHIELD_FEE_MDAI = feeFor(WITHDRAW_MDAI, ASSET_MDAI);
const NET_WITHDRAW_WETH = baseAmt(WITHDRAW_WETH, ASSET_WETH) - UNSHIELD_FEE_WETH;
const NET_WITHDRAW_MDAI = baseAmt(WITHDRAW_MDAI, ASSET_MDAI) - UNSHIELD_FEE_MDAI;

describe("multi-asset deposit + withdraw", () => {
    let h: Harness;
    let alice: SdkWallet;
    let weth: Erc20Helpers;
    let mdai: Erc20Helpers;

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.multiAsset,
            fund: [
                { asset: ASSET_WETH, amount: withFee(DEPOSIT_WETH, ASSET_WETH) },
                { asset: ASSET_MDAI, amount: withFee(DEPOSIT_MDAI, ASSET_MDAI) },
            ],
        });
        ({ h } = f);
        ({ alice } = f.w);
        weth = f.token(ASSET_WETH);
        mdai = f.token(ASSET_MDAI);
    });

    /// One deposit-then-withdraw round trip, memoised per asset so the
    /// withdraw `it` can run alone and still have a note to spend.
    function roundTrip(
        token: () => Erc20Helpers,
        asset: AssetId,
        deposit: CircuitAmount,
        withdraw: CircuitAmount,
    ) {
        const deposited = once(async () => {
            const before = await snapshotBalances(token());
            const r = await alice.deposit({ amount: deposit, asset });
            await awaitOwn(alice, r);
            // Read from the deposit's own event, and confirmed to have reached
            // the relayer: the payer is debited on top of principal and the
            // pool's shield fee either way.
            const relayerFee = await expectRelayerPaidOnDeposit(h.provider, r.txHash, asset);
            return { before, relayerFee, after: await snapshotBalances(token()) };
        });
        const withdrawn = once(async () => {
            await deposited();
            const before = await snapshotBalances(token());
            const r = await alice.withdraw({ to: env.recipientAddress, amount: withdraw, asset });
            await awaitOwn(alice, r);
            return {
                before,
                fee: await expectRelayerPaid(r, asset),
                after: await snapshotBalances(token()),
            };
        });
        return { deposited, withdrawn };
    }

    const wethLegs = roundTrip(() => weth, ASSET_WETH, DEPOSIT_WETH, WITHDRAW_WETH);
    const mdaiLegs = roundTrip(() => mdai, ASSET_MDAI, DEPOSIT_MDAI, WITHDRAW_MDAI);

    it("deposit 10 WETH", async () => {
        const { before, relayerFee, after } = await wethLegs.deposited();
        const moved =
            baseAmt(DEPOSIT_WETH, ASSET_WETH) + SHIELD_FEE_WETH + relayerFee * scaleFor(ASSET_WETH);
        expect(after.payer - before.payer).toBe(-moved);
        expect(after.masp - before.masp).toBe(moved);
        expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT_WETH);
    }, TEST_TIMEOUT.SPEND);

    it("deposit 20 mDAI", async () => {
        const { before, relayerFee, after } = await mdaiLegs.deposited();
        const moved =
            baseAmt(DEPOSIT_MDAI, ASSET_MDAI) + SHIELD_FEE_MDAI + relayerFee * scaleFor(ASSET_MDAI);
        expect(after.payer - before.payer).toBe(-moved);
        expect(after.masp - before.masp).toBe(moved);
        expect(alice.balance(ASSET_MDAI)).toBe(DEPOSIT_MDAI);
    }, TEST_TIMEOUT.SPEND);

    it("withdraw 5 WETH (recipient receives net of unshield fee)", async () => {
        const { before, fee, after } = await wethLegs.withdrawn();
        expect(after.recipient - before.recipient).toBe(NET_WITHDRAW_WETH);
        expect(before.masp - after.masp).toBe(NET_WITHDRAW_WETH);
        // The relayer's fee stays in the pool as a note, so it shows only in
        // what alice has left, never in the public deltas above.
        expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT_WETH - WITHDRAW_WETH - fee);
    }, TEST_TIMEOUT.SPEND);

    it("withdraw 10 mDAI (recipient receives net of unshield fee)", async () => {
        const { before, fee, after } = await mdaiLegs.withdrawn();
        expect(after.recipient - before.recipient).toBe(NET_WITHDRAW_MDAI);
        expect(before.masp - after.masp).toBe(NET_WITHDRAW_MDAI);
        expect(alice.balance(ASSET_MDAI)).toBe(DEPOSIT_MDAI - WITHDRAW_MDAI - fee);
    }, TEST_TIMEOUT.SPEND);

    it("MASP accrues correct shield + unshield fees per asset", async () => {
        // Sequential, not Promise.all: both legs spend from the same wallet and
        // the same payer account, so overlapping them races the nonce.
        await wethLegs.withdrawn();
        await mdaiLegs.withdrawn();
        // Lower bound: the counter is cumulative on a shared MASP.
        expect(await accruedFee(h.provider, env.token1))
            .toBeGreaterThanOrEqual(SHIELD_FEE_WETH + UNSHIELD_FEE_WETH);
        expect(await accruedFee(h.provider, env.token2))
            .toBeGreaterThanOrEqual(SHIELD_FEE_MDAI + UNSHIELD_FEE_MDAI);
    }, TEST_TIMEOUT.SPEND);
});
