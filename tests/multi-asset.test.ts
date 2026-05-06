// Multi-asset deposit + withdraw flow:
//   1. deposit 10 asset 1 (WETH)
//   2. deposit 20 asset 2 (mDAI)
//   3. withdraw 5 asset 1
//   4. withdraw 10 asset 2
//   5. assert transparent + shielded balances per asset
//
// Pulls merkle paths from fmd-webserver instead of mirroring the tree
// locally — that way the test stays correct even when other test files
// have already advanced the on-chain commitment tree.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import {
    buildWithdraw,
    FmdClient,
    Jubjub,
    type Note,
    Poseidon,
    RelayerClient,
    type SpendableCachedNote,
} from "@lelantos-org/sdk";

import { env } from "../src/env";
import {
    counter,
    type Erc20Helpers,
    inputSlotFor,
    makeWallet,
    noteFor,
    rngForOutput,
    setupErc20,
    setupWeth,
    type TestWallet,
    waitForCm,
} from "../src/scenario";
import {
    currentRoot,
    depositToWallet,
    makeBundleCommon,
    newAuxRng,
} from "./_shared";

const ALICE_NSK = 11n;
const ASSET_WETH = 1n;
const ASSET_MDAI = 2n;
const DEPOSIT_WETH = 10n;
const DEPOSIT_MDAI = 20n;
const WITHDRAW_WETH = 5n;
const WITHDRAW_MDAI = 10n;

describe("multi-asset deposit + withdraw", () => {
    let P: Poseidon;
    let J: Jubjub;
    let provider: ethers.JsonRpcProvider;
    let payer: ethers.Wallet;
    let relayer: RelayerClient;
    let fmd: FmdClient;
    let alice: TestWallet;
    /// Per-asset spendable note. cm is re-derived inside `inputSlotFor`.
    const spendable = new Map<bigint, SpendableCachedNote>();
    let weth: Erc20Helpers;
    let mdai: Erc20Helpers;
    /// Pre-test absolute balances. Other test files may leave residual
    /// state on the same anvil; everything below asserts on deltas.
    interface Snapshot { payer: bigint; masp: bigint; recipient: bigint }
    let baselineWeth: Snapshot;
    let baselineMdai: Snapshot;

    const aliceRng = counter(0xa1cen);
    const auxRng = newAuxRng();

    async function snapshot(t: Erc20Helpers): Promise<Snapshot> {
        return {
            payer: await t.balanceOf(env.payerAddress),
            masp: await t.balanceOf(env.maspAddress),
            recipient: await t.balanceOf(env.recipientAddress),
        };
    }

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        provider = new ethers.JsonRpcProvider(env.rpcUrl);
        payer = new ethers.Wallet(env.payerKey, provider);
        relayer = new RelayerClient(env.relayerUrl);
        fmd = new FmdClient(env.fmdUrl, env.chainId);
        alice = makeWallet(P, J, ALICE_NSK);

        weth = await setupWeth(payer, env.token1, env.maspAddress, DEPOSIT_WETH);
        mdai = await setupErc20(payer, env.token2, env.maspAddress, DEPOSIT_MDAI);

        // Snapshot AFTER setup but BEFORE any deposit, so subsequent
        // assertions describe what the test moved (not what was already
        // sitting on chain from other test files).
        baselineWeth = await snapshot(weth);
        baselineMdai = await snapshot(mdai);
    });

    async function deposit(asset: bigint, amount: bigint) {
        spendable.set(asset, await depositToWallet({
            P, J, relayer, fmd, wallet: alice, nsk: ALICE_NSK,
            amount, rng: aliceRng, auxRng, asset,
        }));
    }

    async function withdraw(asset: bigint, publicOut: bigint) {
        const cur = spendable.get(asset);
        if (!cur) throw new Error(`no spendable note cached for asset ${asset}`);
        const remaining = cur.note.value - publicOut;
        const change0: Note = noteFor(alice, remaining, aliceRng, asset);
        const change1: Note = noteFor(alice, 0n, aliceRng, asset);

        const built = await buildWithdraw({
            ...makeBundleCommon(P, J, asset),
            inputs: [await inputSlotFor(P, fmd, cur), null],
            merkleRoot: await currentRoot(fmd),
            publicOut,
            change: [change0, change1],
            changeRecipients: [alice.recipient, alice.recipient],
            changeRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });
        await relayer.submitTransact(built.payload);
        const indexed = await waitForCm(fmd, built.cm[0]);
        spendable.set(asset, { note: change0, nsk: ALICE_NSK, leafIndex: indexed.leafIndex });
    }

    it("deposit 10 WETH", async () => {
        await deposit(ASSET_WETH, DEPOSIT_WETH);
        const cur = await snapshot(weth);
        expect(cur.payer - baselineWeth.payer).toBe(-DEPOSIT_WETH);
        expect(cur.masp - baselineWeth.masp).toBe(DEPOSIT_WETH);
    });

    it("deposit 20 mDAI", async () => {
        await deposit(ASSET_MDAI, DEPOSIT_MDAI);
        const cur = await snapshot(mdai);
        expect(cur.payer - baselineMdai.payer).toBe(-DEPOSIT_MDAI);
        expect(cur.masp - baselineMdai.masp).toBe(DEPOSIT_MDAI);
    });

    it("withdraw 5 WETH (5 to recipient, 5 stays shielded)", async () => {
        const before = await snapshot(weth);
        await withdraw(ASSET_WETH, WITHDRAW_WETH);
        const cur = await snapshot(weth);
        expect(cur.recipient - before.recipient).toBe(WITHDRAW_WETH);
        expect(before.masp - cur.masp).toBe(WITHDRAW_WETH);
    });

    it("withdraw 10 mDAI (10 to recipient, 10 stays shielded)", async () => {
        const before = await snapshot(mdai);
        await withdraw(ASSET_MDAI, WITHDRAW_MDAI);
        const cur = await snapshot(mdai);
        expect(cur.recipient - before.recipient).toBe(WITHDRAW_MDAI);
        expect(before.masp - cur.masp).toBe(WITHDRAW_MDAI);
    });

    it("balances reconcile across both assets", async () => {
        // Transparent — net moves vs the pre-test baseline.
        const w = await snapshot(weth);
        expect(w.payer - baselineWeth.payer).toBe(-DEPOSIT_WETH);
        expect(w.masp - baselineWeth.masp).toBe(DEPOSIT_WETH - WITHDRAW_WETH);
        expect(w.recipient - baselineWeth.recipient).toBe(WITHDRAW_WETH);

        const m = await snapshot(mdai);
        expect(m.payer - baselineMdai.payer).toBe(-DEPOSIT_MDAI);
        expect(m.masp - baselineMdai.masp).toBe(DEPOSIT_MDAI - WITHDRAW_MDAI);
        expect(m.recipient - baselineMdai.recipient).toBe(WITHDRAW_MDAI);

        // Shielded — alice's per-asset spendable change.
        expect(spendable.get(ASSET_WETH)?.note.value).toBe(DEPOSIT_WETH - WITHDRAW_WETH);
        expect(spendable.get(ASSET_WETH)?.note.asset).toBe(ASSET_WETH);
        expect(spendable.get(ASSET_MDAI)?.note.value).toBe(DEPOSIT_MDAI - WITHDRAW_MDAI);
        expect(spendable.get(ASSET_MDAI)?.note.asset).toBe(ASSET_MDAI);
    });
});
