import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    accruedFee,
    amt,
    ASSETS,
    awaitOwn,
    baseAmt,
    depositFeePaid,
    feePaid,
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

const ASSET_WETH = ASSETS.WETH;
const DEPOSIT_WETH = amt(20n);
const WITHDRAW_WETH = amt(8n);

const SHIELD_FEE = feeFor(DEPOSIT_WETH, ASSET_WETH);
const UNSHIELD_FEE = feeFor(WITHDRAW_WETH, ASSET_WETH);
// The SDK fee floors to 0 at this magnitude, so publicOut == WITHDRAW_WETH.
const NET_WITHDRAW = baseAmt(WITHDRAW_WETH, ASSET_WETH) - UNSHIELD_FEE;

interface Snapshot {
    weth: Record<string, bigint>;
    recipientEth: bigint;
}

describe("withdraw native ETH (WETH unwrap)", () => {
    let h: Harness;
    let alice: SdkWallet;
    let weth: Erc20Helpers;

    /// WETH balances for the tracked accounts plus the recipient's raw ETH.
    /// This path delivers value as coin rather than token, so both have to be
    /// observed in the same snapshot.
    async function snap(): Promise<Snapshot> {
        return {
            weth: await snapshotBalances(weth),
            recipientEth: await h.provider.getBalance(env.recipientAddress),
        };
    }

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.withdrawNative,
            fund: [{ asset: ASSET_WETH, amount: withFee(DEPOSIT_WETH, ASSET_WETH) }],
        });
        ({ h } = f);
        ({ alice } = f.w);
        weth = f.token(ASSET_WETH);
    });

    const deposited = once(async () => {
        const before = await snap();
        const r = await alice.deposit({ amount: DEPOSIT_WETH, asset: ASSET_WETH });
        await awaitOwn(alice, r);
        const relayerFee = await depositFeePaid(h.provider, env.maspAddress, r.txHash);
        return { before, relayerFee, after: await snap() };
    });

    const withdrawn = once(async () => {
        await deposited();
        const before = await snap();
        const r = await alice.withdrawEth({
            to: env.recipientAddress,
            amount: WITHDRAW_WETH,
            asset: ASSET_WETH,
        });
        await awaitOwn(alice, r);
        return { before, fee: feePaid(r), after: await snap() };
    });

    it("deposit WETH (shield leg)", async () => {
        const { before, relayerFee, after } = await deposited();
        const moved =
            baseAmt(DEPOSIT_WETH, ASSET_WETH) +
            SHIELD_FEE +
            relayerFee * scaleFor(ASSET_WETH);
        expect(after.weth.payer - before.weth.payer).toBe(-moved);
        expect(after.weth.masp - before.weth.masp).toBe(moved);
        expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT_WETH);
    }, TEST_TIMEOUT.SPEND);

    it("withdrawEth — recipient receives raw ETH (no WETH delta)", async () => {
        const { before, fee, after } = await withdrawn();
        expect(after.recipientEth - before.recipientEth).toBe(NET_WITHDRAW);
        expect(after.weth.recipient - before.weth.recipient, "arrives as coin, not token").toBe(0n);
        expect(before.weth.masp - after.weth.masp).toBe(NET_WITHDRAW);
        // The relayer's fee stays in the pool as a note, so it appears only in
        // what alice has left, never in the public deltas above.
        expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT_WETH - WITHDRAW_WETH - fee);
    }, TEST_TIMEOUT.SPEND);

    it("MASP accrues shield + unshield fees in WETH", async () => {
        await withdrawn();
        // Lower bound: the counter is cumulative on a shared MASP.
        expect(await accruedFee(h.provider, env.token1))
            .toBeGreaterThanOrEqual(SHIELD_FEE + UNSHIELD_FEE);
    }, TEST_TIMEOUT.SPEND);
});
