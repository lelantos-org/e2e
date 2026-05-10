// E2E happy-path + revert paths for the swap stack.
//
// Wires: deposit asset 2 -> /v1/swap (relayer builds tree_update_batch +
// SwapWrapper.swap calldata) -> wrapper does MASP.withdraw -> mock
// adapter delivers asset 3 -> wrapper escrows via submitIntentAuthorized
// -> existing FlushPipeline materialises the B note. Test then asserts
// the B commitment is indexed and decryptable by the recipient wallet.

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { ASSET, MOCK_ERC20_ABI, baseAmt, feeFor } from "../src/constants";
import { env } from "../src/env";
import {
    counter,
    type Erc20Helpers,
    type Harness,
    type Note,
    newAuxRng,
    noteFor,
    setupErc20,
    setupHarness,
    type SpendableCachedNote,
    type TestWallet,
    deposit,
    makeWallet,
    waitForCm,
    withFee,
    subscribe,
} from "../src/harness";
import {
    executeSwap,
    quoteSwap,
    setMockNextOut,
    setMockQuote,
    setupSwapHarness,
    type SwapHarness,
} from "../src/swap-harness";

const ALICE_NSK = 0x55_a1ce_a11c0n;
const ASSET_OUT = 3n;        // mWBTC, scale = 1
const FEE_TIER = 500;

describe("masp swap e2e", () => {
    let h: Harness;
    let s: SwapHarness;
    let alice: TestWallet;
    let mDai: Erc20Helpers;
    let mWbtc: ethers.Contract;
    let aliceNotes: SpendableCachedNote[] = [];

    const aliceRng = counter(0x55_a1ce_0001n);
    const auxRng = newAuxRng(0x55_add_0001n);

    beforeAll(async () => {
        h = await setupHarness();
        s = setupSwapHarness();
        alice = makeWallet(h.P, h.J, ALICE_NSK);
        await subscribe(h.fmd, alice);

        // Fund alice with mDAI + Permit2 allowance for the deposit.
        mDai = await setupErc20(h.payer, env.token2, env.permit2Address, withFee(1_000n));

        // Pre-fund the mock swap router with mWBTC so the adapter has
        // something to push back to the wrapper. Mock router transfers
        // `nextOut` (base units, scale=1 for mWBTC) per swap call.
        const tokenOutAddr = process.env.TOKEN_3!;
        mWbtc = new ethers.Contract(tokenOutAddr, MOCK_ERC20_ABI, h.payer);
        await (await mWbtc.mint(s.mockSwapRouterAddress, 10_000n)).wait();

        // Default mock quote drives metaquoter responses across tests.
        // setMockNextOut is per-test so the adapter's actual delivery can
        // diverge from what the quoter advertised.
        await setMockQuote(h.payer, s, {
            tokenIn: env.token2,
            tokenOut: tokenOutAddr,
            fee: FEE_TIER,
            amountOut: 100n,         // raw mWBTC base units
            gasEstimate: 80_000n,
        });
    });

    it("happy path: deposit asset 2 -> swap -> fresh asset 3 note", async () => {
        // 1. Deposit 100 mDAI publicIn-units so alice has a spendable note.
        const aliceCached = await deposit({
            h, wallet: alice, nsk: ALICE_NSK, amount: 100n, rng: aliceRng, auxRng,
        });
        aliceNotes.push(aliceCached);

        // 2. Quote.
        const quote = await quoteSwap(s, {
            chainId: 31337,
            tokenIn: env.token2 as `0x${string}`,
            tokenOut: process.env.TOKEN_3 as `0x${string}`,
            // MASP charges fee on withdraw; wrapper holds the net amount
            // and feeds that to the adapter, so the quote must price the
            // net not the gross.
            amountIn: baseAmt(100n) - feeFor(100n),
            slippageBps: 50,
        });
        expect(quote.venue).toBe("univ3");
        expect(quote.adapter.toLowerCase()).toBe(s.adapterAddress.toLowerCase());
        expect(quote.expectedOut).toBeGreaterThan(0n);
        expect(quote.minOut).toBeLessThanOrEqual(quote.expectedOut);

        // 3. Configure the mock router to deliver the venue's gross output.
        //    Wrapper then pulls `minOut + minOut*feeBps/10000` from itself,
        //    forwards the rest to treasury.
        await setMockNextOut(h.payer, s, 100n);

        // 4. Execute. Spends `aliceCached` fully (change = [0, 0]).
        const change: [Note, Note] = [
            noteFor(alice, 0n, aliceRng),
            noteFor(alice, 0n, aliceRng),
        ];
        // Mint a B-side note for `quote.minOut` of mWBTC. publicIn unit ==
        // base unit because mWBTC scale = 1.
        const bNote: Note = {
            asset: ASSET_OUT,
            value: quote.minOut,
            pk: alice.keys.pk,
            rho: aliceRng(),
            rcm: aliceRng(),
            rcv: aliceRng(),
        };

        const { txHash, intentBundle } = await executeSwap({
            h, s,
            input: aliceCached,
            recipient: alice,
            assetIn: ASSET,
            assetOut: ASSET_OUT,
            change,
            changeRecipient: alice,
            publicOut: 100n,
            quote,
            bNote,
            auxRng,
        });

        expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

        // 5. Wait for the B commitment to land in fmd. The relayer's
        //    flushBatch worker materialises it asynchronously after the
        //    swap tx is mined.
        const cmB = intentBundle.cm[0];
        const indexed = await waitForCm(h.fmd, cmB);
        expect(indexed.leafIndex).toBeGreaterThanOrEqual(0);
    });

    it("reverts when adapter is not allowlisted", async () => {
        // Re-deposit so we have a fresh spendable note.
        const cached = await deposit({
            h, wallet: alice, nsk: ALICE_NSK, amount: 100n, rng: aliceRng, auxRng,
        });

        const quote = await quoteSwap(s, {
            chainId: 31337,
            tokenIn: env.token2 as `0x${string}`,
            tokenOut: process.env.TOKEN_3 as `0x${string}`,
            amountIn: baseAmt(100n),
            slippageBps: 50,
        });
        await setMockNextOut(h.payer, s, 100n);

        const change: [Note, Note] = [
            noteFor(alice, 0n, aliceRng),
            noteFor(alice, 0n, aliceRng),
        ];
        const bNote: Note = {
            asset: ASSET_OUT,
            value: quote.minOut,
            pk: alice.keys.pk,
            rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng(),
        };

        await expect(
            executeSwap({
                h, s,
                input: cached,
                recipient: alice,
                assetIn: ASSET, assetOut: ASSET_OUT,
                change, changeRecipient: alice,
                publicOut: 100n, quote, bNote, auxRng,
                adapterOverride: "0x000000000000000000000000000000000000dEaD",
            }),
        ).rejects.toThrow(/AdapterNotAllowed|reverted|adapter/i);
    });

    it("reverts when adapter under-delivers vs minOut", async () => {
        const cached = await deposit({
            h, wallet: alice, nsk: ALICE_NSK, amount: 100n, rng: aliceRng, auxRng,
        });

        const quote = await quoteSwap(s, {
            chainId: 31337,
            tokenIn: env.token2 as `0x${string}`,
            tokenOut: process.env.TOKEN_3 as `0x${string}`,
            amountIn: baseAmt(100n),
            slippageBps: 50,
        });
        // Force the router to push less than `minOut`. Wrapper bubbles
        // the adapter revert up.
        await setMockNextOut(h.payer, s, 1n);

        const change: [Note, Note] = [
            noteFor(alice, 0n, aliceRng),
            noteFor(alice, 0n, aliceRng),
        ];
        const bNote: Note = {
            asset: ASSET_OUT,
            value: quote.minOut,
            pk: alice.keys.pk,
            rho: aliceRng(), rcm: aliceRng(), rcv: aliceRng(),
        };

        await expect(
            executeSwap({
                h, s,
                input: cached,
                recipient: alice,
                assetIn: ASSET, assetOut: ASSET_OUT,
                change, changeRecipient: alice,
                publicOut: 100n, quote, bNote, auxRng,
            }),
        ).rejects.toThrow(/insufficient|minOut|too little|reverted/i);
    });
});
