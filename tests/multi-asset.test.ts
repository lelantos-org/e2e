// Multi-asset deposit + withdraw flow:
//   1. deposit 10 asset 1 (WETH)
//   2. deposit 20 asset 2 (mDAI)
//   3. withdraw 5 asset 1
//   4. withdraw 10 asset 2
// Asserts transparent + shielded balances per asset.

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
    setupErc20,
    setupHarness,
    setupWeth,
    snapshotBalances,
    type SpendableCachedNote,
    submitWithdraw,
    type TestWallet,
    withFee,
} from "../src/harness";

const ALICE_NSK = 0xaa_a1ce_a11c0n;
const ASSET_WETH = 1n;
const ASSET_MDAI = 2n;
const DEPOSIT_WETH = 10n;
const DEPOSIT_MDAI = 20n;
const WITHDRAW_WETH = 5n;
const WITHDRAW_MDAI = 10n;

describe("multi-asset deposit + withdraw", () => {
    let h: Harness;
    let alice: TestWallet;
    let weth: Erc20Helpers;
    let mdai: Erc20Helpers;
    let baselineWeth: Record<string, bigint>;
    let baselineMdai: Record<string, bigint>;
    /// Per-asset spendable note. cm is re-derived inside `inputSlotFor`.
    const spendable = new Map<bigint, SpendableCachedNote>();

    const aliceRng = counter(0xaa_a1ce_0001n);
    const auxRng = newAuxRng(0xaa_add_0001n);

    const TRACKED = {
        payer: env.payerAddress,
        masp: env.maspAddress,
        recipient: env.recipientAddress,
    };
    const snapshot = (t: Erc20Helpers) => snapshotBalances(t, TRACKED);

    beforeAll(async () => {
        h = await setupHarness();
        alice = makeWallet(h.P, h.J, ALICE_NSK);
        weth = await setupWeth(h.payer, env.token1, env.permit2Address, withFee(DEPOSIT_WETH, ASSET_WETH));
        mdai = await setupErc20(h.payer, env.token2, env.permit2Address, withFee(DEPOSIT_MDAI, ASSET_MDAI));
        // Snapshot AFTER setup but BEFORE any deposit, so subsequent
        // assertions describe what THIS test moved (not residual state
        // from other test files sharing this anvil).
        baselineWeth = await snapshot(weth);
        baselineMdai = await snapshot(mdai);
    });

    async function depositAsset(asset: bigint, amount: bigint) {
        const tokenAddr = asset === ASSET_WETH ? env.token1 : env.token2;
        spendable.set(asset, await deposit({
            h, wallet: alice, nsk: ALICE_NSK, amount, rng: aliceRng, auxRng, asset, tokenAddr,
        }));
    }

    async function withdrawAsset(asset: bigint, publicOut: bigint) {
        const cur = spendable.get(asset);
        if (!cur) throw new Error(`no spendable note cached for asset ${asset}`);
        const remaining = cur.note.value - publicOut;
        const change0: Note = noteFor(alice, remaining, aliceRng, asset);
        const change1: Note = noteFor(alice, 0n, aliceRng, asset);

        const built = await submitWithdraw({
            h, input: cur, publicOut, change: [change0, change1],
            changeRecipient: alice, auxRng, asset,
        });
        spendable.set(asset, {
            note: change0,
            nsk: ALICE_NSK,
            // submitWithdraw waits for cm[0] (change0); refetch leaf via inputSlotFor on next spend.
            leafIndex: 0,
        });
        return built;
    }

    // Shield: payer pays inAmt + fee, MASP balance bumps by inAmt + fee.
    // Unshield: MASP sends outAmt - fee to recipient, fee stays accrued.
    // All numbers below in token base-units (publicIn × per-asset scale).
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
        await depositAsset(ASSET_WETH, DEPOSIT_WETH);
        const cur = await snapshot(weth);
        expect(cur.payer - baselineWeth.payer).toBe(-(DEPOSIT_WETH_BASE + SHIELD_FEE_WETH));
        expect(cur.masp - baselineWeth.masp).toBe(DEPOSIT_WETH_BASE + SHIELD_FEE_WETH);
    });

    it("deposit 20 mDAI", async () => {
        await depositAsset(ASSET_MDAI, DEPOSIT_MDAI);
        const cur = await snapshot(mdai);
        expect(cur.payer - baselineMdai.payer).toBe(-(DEPOSIT_MDAI_BASE + SHIELD_FEE_MDAI));
        expect(cur.masp - baselineMdai.masp).toBe(DEPOSIT_MDAI_BASE + SHIELD_FEE_MDAI);
    });

    it("withdraw 5 WETH (recipient receives net of unshield fee)", async () => {
        const before = await snapshot(weth);
        await withdrawAsset(ASSET_WETH, WITHDRAW_WETH);
        const cur = await snapshot(weth);
        expect(cur.recipient - before.recipient).toBe(NET_WITHDRAW_WETH);
        expect(before.masp - cur.masp).toBe(NET_WITHDRAW_WETH);
    });

    it("withdraw 10 mDAI (recipient receives net of unshield fee)", async () => {
        const before = await snapshot(mdai);
        await withdrawAsset(ASSET_MDAI, WITHDRAW_MDAI);
        const cur = await snapshot(mdai);
        expect(cur.recipient - before.recipient).toBe(NET_WITHDRAW_MDAI);
        expect(before.masp - cur.masp).toBe(NET_WITHDRAW_MDAI);
    });

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

        expect(spendable.get(ASSET_WETH)?.note.value).toBe(DEPOSIT_WETH - WITHDRAW_WETH);
        expect(spendable.get(ASSET_WETH)?.note.asset).toBe(ASSET_WETH);
        expect(spendable.get(ASSET_MDAI)?.note.value).toBe(DEPOSIT_MDAI - WITHDRAW_MDAI);
        expect(spendable.get(ASSET_MDAI)?.note.asset).toBe(ASSET_MDAI);
    });

    it("MASP accrues correct shield + unshield fees per asset", async () => {
        const masp = new ethers.Contract(env.maspAddress, [
            "function accruedFee(address) view returns (uint256)",
        ], h.provider);
        const wethAccrued = (await masp.accruedFee(env.token1)) as bigint;
        const mdaiAccrued = (await masp.accruedFee(env.token2)) as bigint;
        // Lower bound — other test files may have accrued more on the
        // shared anvil. This file's contribution must be present.
        expect(wethAccrued).toBeGreaterThanOrEqual(SHIELD_FEE_WETH + UNSHIELD_FEE_WETH);
        expect(mdaiAccrued).toBeGreaterThanOrEqual(SHIELD_FEE_MDAI + UNSHIELD_FEE_MDAI);
    });
});
