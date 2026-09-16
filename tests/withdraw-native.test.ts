import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    amt,
    ASSETS,
    depositTotal,
    feeFor,
    type Harness,
    netOfGross,
    shieldedBalance,
    spendItem,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import { depositStep, withdrawStep } from "../src/testkit/steps.js";

const ASSET_WETH = ASSETS.WETH;
const DEPOSIT_WETH = amt(20n);
const WITHDRAW_WETH = amt(8n);

const SHIELD_FEE = feeFor(DEPOSIT_WETH, ASSET_WETH);
const UNSHIELD_FEE = feeFor(WITHDRAW_WETH, ASSET_WETH);
const NET_WITHDRAW = netOfGross(WITHDRAW_WETH, ASSET_WETH);

// The unwrap goes through `NativeAdapter`, which is deployed only when the
// stack includes a wrapped-native token. Skipping rather than failing makes a
// partial stack report "not exercised" instead of "broken".
describe.skipIf(!env.nativeAdapterAddress)("withdraw native ETH (WETH unwrap)", () => {
    let h: Harness;
    let alice: SdkWallet;

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.withdrawNative,
            fund: [{ asset: ASSET_WETH, amount: withFee(DEPOSIT_WETH, ASSET_WETH) }],
        });
        ({ h } = f);
        ({ alice } = f.w);
    });

    const deposited = once(() => depositStep(h, alice, { amount: DEPOSIT_WETH, asset: ASSET_WETH }));

    const withdrawn = once(async () => {
        await deposited();
        // This path delivers value as coin rather than token, so the recipient's
        // raw ETH is tracked alongside the WETH balances.
        return withdrawStep(
            h,
            alice,
            { recipient: env.recipientAddress, gross: WITHDRAW_WETH, asset: ASSET_WETH, native: true },
            { eth: { recipient: env.recipientAddress } },
        );
    });

    it("deposit WETH (shield leg)", async () => {
        const { erc20, fee } = await deposited();
        const moved = depositTotal(DEPOSIT_WETH, fee, ASSET_WETH);
        expect(erc20.payer).toBe(-moved);
        expect(erc20.masp).toBe(moved);
        expect(await shieldedBalance(alice, ASSET_WETH)).toBe(DEPOSIT_WETH);
    }, TEST_TIMEOUT.DEPOSIT);

    it("withdraw native — recipient receives raw ETH (no WETH delta)", async () => {
        const { r, erc20, eth, fee } = await withdrawn();
        expect(eth.recipient).toBe(NET_WITHDRAW);
        expect(erc20.recipient, "arrives as coin, not token").toBe(0n);
        expect(erc20.masp).toBe(-NET_WITHDRAW);
        // Landed through the adapter's unwrap, not as a plain unshield that
        // happened to pay the same amount.
        expect((await spendItem(h.provider, r)).kind).toBe("withdrawNative");
        // The relayer's fee stays in the pool as a note, so it appears only in
        // what alice has left, never in the public deltas above.
        expect(await shieldedBalance(alice, ASSET_WETH)).toBe(DEPOSIT_WETH - WITHDRAW_WETH - fee);
    }, TEST_TIMEOUT.SEQUENCE);

    it("MASP accrues shield + unshield fees in WETH", async () => {
        const shield = await deposited();
        const unshield = await withdrawn();
        expect(shield.accrued, "shield fee").toBe(SHIELD_FEE);
        expect(unshield.accrued, "unshield fee").toBe(UNSHIELD_FEE);
    }, TEST_TIMEOUT.SEQUENCE);
});
