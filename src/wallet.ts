import {
    connect,
    type ConnectStorage,
    type EthSigner,
    type HttpOptions,
    type NetworkPreset,
    type ProverConfig,
    type WalletApi,
} from "@lelantos-org/sdk";
import { createWallet, type Submitter, ViemChainAdapter } from "@lelantos-org/sdk/advanced";
import type { Field } from "@lelantos-org/sdk/primitives";
import type { Prover } from "@lelantos-org/sdk/prover";

import { TREE_DEPTH } from "./protocol/shape.js";
import { env } from "./env.js";
import { PROVER_PATHS } from "./testkit/prover.js";
import { payerEthSigner } from "./signers.js";
import { log } from "./utils.js";

export interface CreateWalletOpts {
    signer?: EthSigner;
    /**
     * Per-attempt deadline for a spend submit, in ms. The SDK default of 30s
     * covers a relayer that sends at once; a test holding the relayer's batcher
     * keeps submits open for as long as it takes to queue the rest of the
     * bundle, which with several wallets proving concurrently runs past it. The
     * request would then time out and retry while the operation is still
     * queued. Reads and estimates keep the SDK's own deadline.
     */
    submitTimeoutMs?: number;
    /**
     * Replaces the default HTTP submitter. `connect` takes no submitter, so the
     * wallet is then built with `createWallet` from `./advanced`, on the same
     * network, chain layer and prover. `submitTimeoutMs` still applies to the
     * default HTTP clients it builds, not to this submitter.
     */
    submitter?: Submitter;
    /**
     * Replaces the default prover, the WASM one, whose `prove` blocks the event
     * loop until its thread pool answers. See `tests/bundler-mixed.test.ts` for
     * the case that needs another.
     */
    prover?: Prover;
    /**
     * Where the wallet keeps its notes, tree and spent set. In-memory and
     * per-wallet by default, so nothing survives `dispose()`.
     *
     * A test that outlives one wallet — a restart, two clients on one key —
     * passes the same backends to both, which is what makes the second wallet
     * a restart of the first rather than a fresh scan.
     */
    storage?: ConnectStorage;
    /**
     * Extra HTTP attempts after the first, and the transport under them.
     *
     * `retries` follows the SDK's own rules: reads retry broadly, submits only
     * where the relayer cannot have acted (no response, 429, 503). `fetch`
     * replaces the transport, for a test that has to see or hold the wire —
     * see `testkit/raw-relayer.ts`.
     */
    retries?: number;
    fetch?: typeof fetch;
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
    depositFeeAsset: { alice: 0xfa_a1ce_a11c0n },
    batchFlush:     { alice: 0xbf_a1ce_a11c0n },
    swap:           { alice: 0x55_a1ce_a11c0n },
    submitRetry:    { alice: 0x51_a1ce_a11c0n, bob: 0x51_b0b_b0b00n },
    walletRestart:  { alice: 0x52_a1ce_a11c0n, bob: 0x52_b0b_b0b00n },
    consolidate:    { alice: 0x53_a1ce_a11c0n, bob: 0x53_b0b_b0b00n },
    spendableMax:   { alice: 0x54_a1ce_a11c0n, bob: 0x54_b0b_b0b00n },
    relayerAdmission: { alice: 0x56_a1ce_a11c0n, bob: 0x56_b0b_b0b00n },
    negExpired:     { alice: 0xe1_a1ce_a11c0n },
    negZeroValue:   { alice: 0xe2_a1ce_a11c0n },
    negDepositFee:  { alice: 0xe3_a1ce_a11c0n },
    edgeConcurrent: { alice: 0xed_a1ce_a11c0n, bob: 0xed_b0b_b0b00n },
    // One sender per operation kind in the mixed bundle (alice to bob, carol,
    // dave, erin), two for the dropped-flush case (frank, grace), two for the
    // double-spend window (heidi, ivan) and one for the binding case (judy).
    // `sink` receives the direct deposits the mixed bundle flushes and is never
    // built as a wallet.
    bundlerMixed: {
        alice: 0xb1_a1ce_a11c0n, bob: 0xb1_b0b_b0b00n, carol: 0xb1_ca10_ca100n,
        dave: 0xb1_da7e_da7e0n, erin: 0xb1_e41e_e41e0n, frank: 0xb1_f4a4_f4a40n,
        grace: 0xb1_64ac_64ac0n, heidi: 0xb1_4e1d_4e1d0n, ivan: 0xb1_1fa4_1fa40n,
        judy: 0xb1_1ad9_1ad90n, sink: 0xb1_5140_51400n,
    },
    // `bundlerCap` wallets are numbered: `base + i` for each of the cap case's
    // `bundle_max_items + 2` senders, so the count follows the relayer config.
    bundlerCap:     { base: 0xb2_ca9_00000n },
    denominated:    { alice: 0xd0_a1ce_a11c0n },
    yieldWithdraw:  { alice: 0x71_a1ce_a11c0n },
    yieldLiquidity: { alice: 0x72_a1ce_a11c0n },
} as const;

/**
 * Wallets built by `createTestWallet` and not yet disposed.
 *
 * The suite runs in one fork (`singleFork`, see `vitest.config.ts`), so every
 * wallet's scanner and prover stay resident for the rest of the run unless
 * released. Test files build wallets in `beforeAll` and ad hoc inside `it`s, so
 * they are tracked here and `src/test-setup.ts` drains the set after each file.
 */
const live = new Set<WalletApi>();

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

/**
 * This stack as an SDK network preset. Read lazily, so `env` is not touched at
 * import time.
 *
 * Every address is deploy-dependent, so none of the SDK's own `anvil` preset
 * applies: the stack's one-shot deploy mints them and `globalSetup` publishes
 * them into the environment.
 */
function e2eNetwork(): NetworkPreset {
    return {
        chainId: env.chainId,
        maspAddress: env.maspAddress,
        // The Bundler, not the relayer's signer: it is the pool's caller, so it
        // is what `pi.relayer` and a swap's `payer` must name.
        relayerAddress: env.bundlerAddress,
        relayerUrl: env.relayerUrl,
        fmdUrl: env.fmdUrl,
        rpcUrl: env.rpcUrl,
        treeDepth: TREE_DEPTH,
        permit2Address: env.permit2Address,
        // Enables `deposit({ native: true })` and `withdraw({ native: true })`.
        // Both bind to this address rather than to the pool.
        nativeAdapterAddress: env.nativeAdapterAddress,
        // Present only when the swap stack was deployed; without them the
        // wallet's `capabilities.swap` is false and `quoteSwap` refuses.
        quoterUrl: env.metaquoterUrl,
        swapWrapperAddress: env.swapWrapperAddress,
    };
}

export async function createTestWallet(
    nsk: Field,
    opts: CreateWalletOpts = {},
): Promise<WalletApi> {
    const signer = opts.signer ?? payerEthSigner();
    const network = e2eNetwork();
    // The WASM prover over the circuits package this suite pins, unless the
    // caller supplies another.
    const prover: Prover | ProverConfig = opts.prover ?? {
        artifacts: PROVER_PATHS,
        backend: "wasm",
    };
    const http: HttpOptions = {
        ...(opts.submitTimeoutMs !== undefined ? { submitTimeoutMs: opts.submitTimeoutMs } : {}),
        ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
        ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    };
    const storage = opts.storage;

    const wallet =
        opts.submitter === undefined
            ? await connect({ network, nsk, signer, prover, http, storage })
            : await createWallet(
                  { type: "nsk", nsk },
                  {
                      chainId: network.chainId,
                      treeDepth: network.treeDepth,
                      relayerAddress: network.relayerAddress,
                      chain: new ViemChainAdapter({
                          rpcUrl: env.rpcUrl,
                          signer,
                          maspAddress: network.maspAddress,
                          permit2Address: network.permit2Address,
                          nativeAdapterAddress: network.nativeAdapterAddress,
                          chainId: network.chainId,
                      }),
                      fmdUrl: network.fmdUrl,
                      relayerUrl: network.relayerUrl,
                      quoterUrl: network.quoterUrl,
                      swapWrapperAddress: network.swapWrapperAddress,
                      submitter: opts.submitter,
                      prover,
                      http,
                      ...(storage?.notes ? { noteStore: storage.notes } : {}),
                      ...(storage?.tree ? { treePersistence: storage.tree } : {}),
                      ...(storage?.nullifiers ? { nullifierPersistence: storage.nullifiers } : {}),
                  },
              );
    live.add(wallet);
    return wallet;
}
