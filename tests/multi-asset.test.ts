import { beforeAll, describe, expect, it } from "vitest";

import type { AssetId, CircuitAmount } from "@lelantos-org/sdk";

import { env } from "../src/env.js";
import {
    amt,
    ASSETS,
    depositTotal,
    feeFor,
    type Harness,
    netOfGross,
    shieldedBalance,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import { depositStep, withdrawStep } from "../src/testkit/steps.js";

const { WETH: ASSET_WETH, MDAI: ASSET_MDAI } = ASSETS;
const DEPOSIT_WETH = amt(10n);
const DEPOSIT_MDAI = amt(20n);
const WITHDRAW_WETH = amt(5n);
const WITHDRAW_MDAI = amt(10n);

const SHIELD_FEE_WETH = feeFor(DEPOSIT_WETH, ASSET_WETH);
const SHIELD_FEE_MDAI = feeFor(DEPOSIT_MDAI, ASSET_MDAI);
const UNSHIELD_FEE_WETH = feeFor(WITHDRAW_WETH, ASSET_WETH);
const UNSHIELD_FEE_MDAI = feeFor(WITHDRAW_MDAI, ASSET_MDAI);
const NET_WITHDRAW_WETH = netOfGross(WITHDRAW_WETH, ASSET_WETH);
const NET_WITHDRAW_MDAI = netOfGross(WITHDRAW_MDAI, ASSET_MDAI);

/** Both assets' deposit and withdraw legs, which the fee `it` pulls in. */
const BOTH_ROUND_TRIPS_TIMEOUT = 2 * (TEST_TIMEOUT.DEPOSIT + TEST_TIMEOUT.SPEND);

describe("multi-asset deposit + withdraw", () => {
    let h: Harness;
    let alice: SdkWallet;

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
    });

    /// One deposit-then-withdraw round trip, memoised per asset so the
    /// withdraw `it` can run alone and still have a note to spend.
    function roundTrip(asset: AssetId, deposit: CircuitAmount, withdraw: CircuitAmount) {
        const deposited = once(() => depositStep(h, alice, { amount: deposit, asset }));
        const withdrawn = once(async () => {
            await deposited();
            return withdrawStep(h, alice, { recipient: env.recipientAddress, gross: withdraw, asset });
        });
        return { deposited, withdrawn };
    }

    const wethLegs = roundTrip(ASSET_WETH, DEPOSIT_WETH, WITHDRAW_WETH);
    const mdaiLegs = roundTrip(ASSET_MDAI, DEPOSIT_MDAI, WITHDRAW_MDAI);

    it("deposit 10 WETH", async () => {
        // The relayer's fee is read from the deposit's own escrow, and confirmed
        // to have reached the relayer: the payer is debited it on top of
        // principal and the pool's shield fee.
        const { erc20, fee } = await wethLegs.deposited();
        const moved = depositTotal(DEPOSIT_WETH, fee, ASSET_WETH);
        expect(erc20.payer).toBe(-moved);
        expect(erc20.masp).toBe(moved);
        expect(await shieldedBalance(alice, ASSET_WETH)).toBe(DEPOSIT_WETH);
    }, TEST_TIMEOUT.DEPOSIT);

    it("deposit 20 mDAI", async () => {
        const { erc20, fee } = await mdaiLegs.deposited();
        const moved = depositTotal(DEPOSIT_MDAI, fee, ASSET_MDAI);
        expect(erc20.payer).toBe(-moved);
        expect(erc20.masp).toBe(moved);
        expect(await shieldedBalance(alice, ASSET_MDAI)).toBe(DEPOSIT_MDAI);
    }, TEST_TIMEOUT.DEPOSIT);

    it("withdraw 5 WETH (recipient receives net of unshield fee)", async () => {
        const { erc20, fee } = await wethLegs.withdrawn();
        expect(erc20.recipient).toBe(NET_WITHDRAW_WETH);
        expect(erc20.masp).toBe(-NET_WITHDRAW_WETH);
        expect(erc20.payer, "a relayed spend costs the payer nothing").toBe(0n);
        // The relayer's fee stays in the pool as a note, so it shows only in
        // what alice has left, never in the public deltas above.
        expect(await shieldedBalance(alice, ASSET_WETH)).toBe(DEPOSIT_WETH - WITHDRAW_WETH - fee);
    }, TEST_TIMEOUT.SEQUENCE);

    it("withdraw 10 mDAI (recipient receives net of unshield fee)", async () => {
        const { erc20, fee } = await mdaiLegs.withdrawn();
        expect(erc20.recipient).toBe(NET_WITHDRAW_MDAI);
        expect(erc20.masp).toBe(-NET_WITHDRAW_MDAI);
        expect(erc20.payer, "a relayed spend costs the payer nothing").toBe(0n);
        expect(await shieldedBalance(alice, ASSET_MDAI)).toBe(DEPOSIT_MDAI - WITHDRAW_MDAI - fee);
    }, TEST_TIMEOUT.SEQUENCE);

    it("MASP accrues correct shield + unshield fees per asset", async () => {
        // Sequential, not Promise.all: both legs spend from the same wallet and
        // the same payer account, so overlapping them races the nonce.
        const wethIn = await wethLegs.deposited();
        const wethOut = await wethLegs.withdrawn();
        const mdaiIn = await mdaiLegs.deposited();
        const mdaiOut = await mdaiLegs.withdrawn();
        // Each leg's own delta, so the counter is attributed per token: a fee
        // accrued under the other asset's token would show up here as a miss.
        expect(wethIn.accrued, "WETH shield fee").toBe(SHIELD_FEE_WETH);
        expect(wethOut.accrued, "WETH unshield fee").toBe(UNSHIELD_FEE_WETH);
        expect(mdaiIn.accrued, "mDAI shield fee").toBe(SHIELD_FEE_MDAI);
        expect(mdaiOut.accrued, "mDAI unshield fee").toBe(UNSHIELD_FEE_MDAI);
    }, BOTH_ROUND_TRIPS_TIMEOUT);
});
