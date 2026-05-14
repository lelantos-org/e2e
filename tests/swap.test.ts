import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { ASSET, ASSETS, baseAmt, DEAD_ADDRESS, feeFor, MOCK_ERC20_ABI } from "../src/constants.js";
import { env } from "../src/env.js";
import {
    createTestWallet,
    type Erc20Helpers,
    fundPayerForAsset,
    type Harness,
    POLL,
    setupHarness,
    TEST_NSK,
    withFee,
} from "../src/harness.js";
import {
    quoteSwap,
    setMockNextOut,
    setMockQuote,
    setupSwapHarness,
    type SwapHarness,
} from "../src/swap-harness.js";

const { alice: ALICE_NSK } = TEST_NSK.swap;
const ASSET_OUT = ASSETS.MWBTC;
const FEE_TIER = 500;

describe("masp swap e2e", () => {
    let h: Harness;
    let s: SwapHarness;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;
    let mDai: Erc20Helpers;
    let mWbtc: ethers.Contract;

    beforeAll(async () => {
        h = await setupHarness();
        s = setupSwapHarness();
        alice = await createTestWallet(h, ALICE_NSK);

        mDai = await fundPayerForAsset(h, ASSET, withFee(1_000n));

        // Fund the mock router with mWBTC; adapter needs output liquidity.
        const tokenOutAddr = process.env.TOKEN_3!;
        mWbtc = new ethers.Contract(tokenOutAddr, MOCK_ERC20_ABI, h.payer);
        await (await mWbtc.mint(s.mockSwapRouterAddress, 10_000n)).wait();

        await setMockQuote(h.payer, s, {
            tokenIn: env.token2,
            tokenOut: tokenOutAddr,
            fee: FEE_TIER,
            amountOut: 100n,
            gasEstimate: 80_000n,
        });
    });

    // 105 covers a 100-unit swap (publicOut=100+fee=105).
    async function depositForSwap(amount: bigint) {
        const r = await alice.deposit({ amount, asset: ASSET });
        await alice.awaitCommitments(r.commitments, POLL.COMMITMENT);
    }

    it("happy path: deposit asset 2 -> swap -> fresh asset 3 note", async () => {
        await depositForSwap(105n);

        const quote = await quoteSwap(s, {
            chainId: 31337,
            tokenIn: env.token2 as `0x${string}`,
            tokenOut: process.env.TOKEN_3 as `0x${string}`,
            amountIn: baseAmt(100n) - feeFor(100n),
            slippageBps: 50,
        });
        expect(quote.venue).toBe("univ3");
        expect(quote.adapter.toLowerCase()).toBe(s.adapterAddress.toLowerCase());
        await setMockNextOut(h.payer, s, 100n);

        const r = await alice.swap({
            assetIn: ASSET,
            assetOut: ASSET_OUT,
            amount: 100n,
            quote,
            wrapperAddress: s.wrapperAddress,
        });

        // Relayer flushes the B-note asynchronously.
        await alice.awaitCommitments(r.commitments, POLL.COMMITMENT);
        expect(alice.balance(ASSET_OUT)).toBeGreaterThan(0n);
    }, 360_000);

    it("reverts when adapter is not allowlisted", async () => {
        await depositForSwap(105n);
        const quote = await quoteSwap(s, {
            chainId: 31337,
            tokenIn: env.token2 as `0x${string}`,
            tokenOut: process.env.TOKEN_3 as `0x${string}`,
            amountIn: baseAmt(100n),
            slippageBps: 50,
        });
        await setMockNextOut(h.payer, s, 100n);

        const badQuote = { ...quote, adapter: DEAD_ADDRESS as `0x${string}` };
        await expect(
            alice.swap({
                assetIn: ASSET,
                assetOut: ASSET_OUT,
                amount: 100n,
                quote: badQuote,
                wrapperAddress: s.wrapperAddress,
            }),
        ).rejects.toThrow(/AdapterNotAllowed|reverted|adapter/i);
    }, 360_000);

    it("reverts when adapter under-delivers vs minOut", async () => {
        await depositForSwap(105n);
        const quote = await quoteSwap(s, {
            chainId: 31337,
            tokenIn: env.token2 as `0x${string}`,
            tokenOut: process.env.TOKEN_3 as `0x${string}`,
            amountIn: baseAmt(100n),
            slippageBps: 50,
        });
        await setMockNextOut(h.payer, s, 1n);

        await expect(
            alice.swap({
                assetIn: ASSET,
                assetOut: ASSET_OUT,
                amount: 100n,
                quote,
                wrapperAddress: s.wrapperAddress,
            }),
        ).rejects.toThrow(/insufficient|minOut|too little|reverted/i);
    }, 360_000);
});
