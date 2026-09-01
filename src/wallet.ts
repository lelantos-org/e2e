import {
    type DenominationPolicy,
    type EthSigner,
    InMemoryNoteStore,
    nodeWallet,
    TRANSACT_4X6,
    ViemChainAdapter,
    type Wallet,
} from "@lelantos-org/sdk";
import type { Field } from "@lelantos-org/sdk/crypto";

import { RELAYER } from "./accounts.js";
import { TREE_DEPTH } from "./protocol/shape.js";
import { env } from "./env.js";
import { PROVER_PATHS } from "./testkit/prover.js";
import { payerEthSigner } from "./signers.js";
import { log } from "./utils.js";

export interface CreateWalletOpts {
    signer?: EthSigner;
    noteStore?: InMemoryNoteStore;
    /**
     * Withdrawal denominations, keyed by token address.
     *
     * The SDK's built-in ladders are keyed by mainnet USDC/WETH addresses, so
     * the mock tokens this stack deploys resolve to no ladder at all and every
     * denomination path is inert. A test that wants one has to supply it, and
     * can only do so after the deploy has named the token.
     */
    denominations?: DenominationPolicy;
}

// Each test file uses a distinct prefix. Files share one anvil and one FMD
// index, so colliding NSKs leak notes across tests.
export const TEST_NSK = {
    fullFlow:       { alice: 0xff_a1ce_a11c0n, bob: 0xff_b0b_b0b00n },
    doubleSpend:    { alice: 0xdd_a1ce_a11c0n, bob: 0xdd_b0b_b0b00n },
    clientResync:   { alice: 0xcc_a1ce_a11c0n, bob: 0xcc_b0b_b0b00n },
    twoInputMerge:  { alice: 0x22_a1ce_a11c0n, bob: 0x22_b0b_b0b00n },
    multiAsset:     { alice: 0xaa_a1ce_a11c0n },
    withdrawNative: { alice: 0xee_a1ce_a11c0n },
    depositNative:  { alice: 0xde_a1ce_a11c0n },
    batchFlush:     { alice: 0xbf_a1ce_a11c0n },
    swap:           { alice: 0x55_a1ce_a11c0n },
    negExpired:     { alice: 0xe1_a1ce_a11c0n },
    negZeroValue:   { alice: 0xe2_a1ce_a11c0n },
    negDepositFee:  { alice: 0xe3_a1ce_a11c0n },
    edgeConcurrent: { alice: 0xed_a1ce_a11c0n, bob: 0xed_b0b_b0b00n },
    denominated:    { alice: 0xd0_a1ce_a11c0n },
    yieldWithdraw:  { alice: 0x71_a1ce_a11c0n },
} as const;

/**
 * Wallets built by `createTestWallet` and not yet disposed.
 *
 * The suite runs in one fork (`singleFork`, see `vitest.config.ts`), so every
 * wallet's scanner and prover stay resident for the rest of the run unless
 * released. Test files build wallets in `beforeAll` and ad hoc inside `it`s, so
 * they are tracked here and `src/test-setup.ts` drains the set after each file.
 */
const live = new Set<Wallet>();

/** Run after every drain; see `onWalletsDisposed`. */
const resets = new Set<() => void>();

/**
 * Register `fn` to run whenever the file's wallets are drained.
 *
 * For modules that memoise a wallet at module scope. Module state outlives the
 * drain — the suite runs in one fork — so without this the next file's first
 * call gets a handle whose scanner and prover have already been released, and
 * the failure surfaces as a sync error attributed to that file rather than to
 * the teardown of the previous one.
 */
export function onWalletsDisposed(fn: () => void): void {
    resets.add(fn);
}

/**
 * Dispose every wallet built since the last drain.
 *
 * `dispose()` is idempotent on the SDK side, and a failure here must not fail
 * an otherwise-green file, so rejections are collected and reported once.
 */
export async function disposeTestWallets(): Promise<void> {
    const wallets = [...live];
    live.clear();
    const outcomes = await Promise.allSettled(wallets.map((w) => w.dispose()));
    const failed = outcomes.filter((o) => o.status === "rejected");
    if (failed.length > 0) {
        log(`disposeTestWallets: ${failed.length}/${wallets.length} failed`);
    }
    for (const reset of resets) reset();
}

export async function createTestWallet(
    nsk: Field,
    opts: CreateWalletOpts = {},
): Promise<Wallet> {
    const signer = opts.signer ?? payerEthSigner();
    const chain = new ViemChainAdapter({
        rpcUrl: env.rpcUrl,
        signer,
        maspAddress: env.maspAddress,
        permit2Address: env.permit2Address,
        // Enables `asEth` deposits and `withdrawEth`. Both bind to this
        // address rather than to the pool.
        nativeAdapterAddress: env.nativeAdapterAddress,
        chainId: env.chainId,
    });
    const wallet = await nodeWallet({
        keys: { type: "nsk", nsk },
        config: {
            chainId: env.chainId,
            treeDepth: TREE_DEPTH,
            shape: TRANSACT_4X6,
            relayerAddress: RELAYER.address,
            chain,
            fmdUrl: env.fmdUrl,
            relayerUrl: env.relayerUrl,
            proverPaths: PROVER_PATHS,
            noteStore: opts.noteStore ?? new InMemoryNoteStore(),
            ...(opts.denominations !== undefined ? { denominations: opts.denominations } : {}),
        },
    });
    live.add(wallet);
    return wallet;
}
