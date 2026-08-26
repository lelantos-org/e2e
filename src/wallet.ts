import {
    type EthSigner,
    InMemoryNoteStore,
    nodeWallet,
    TRANSACT_4X4,
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
            shape: TRANSACT_4X4,
            relayerAddress: RELAYER.address,
            chain,
            fmdUrl: env.fmdUrl,
            relayerUrl: env.relayerUrl,
            proverPaths: PROVER_PATHS,
            noteStore: opts.noteStore ?? new InMemoryNoteStore(),
        },
    });
    live.add(wallet);
    return wallet;
}
