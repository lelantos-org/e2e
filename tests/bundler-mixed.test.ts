// The relayer lands several tree-advancing operations in one transaction
// through its Bundler, and each keeps its meaning inside the bundle.
//
// Every other file is sequential and mostly produces bundles of one, so this is
// where bundles of several operations are made on purpose. Natural batching
// cannot be steered from a client — which operations share a transaction is a
// race between proving and blocks — so each case holds the relayer's batcher
// (`src/relayer-hooks.ts`), queues exactly the operations it is about, checks
// the queue, and releases them as one bundle.
//
// What a bundle must preserve, case by case:
//
//   * every entry point lands in one transaction, in queue order with swaps
//     last, and each operation's leaves, nullifiers, public payouts and indexed
//     rows are its own
//   * an operation that can no longer land is dropped before sending, and the
//     rest still go out together
//   * no transaction exceeds `bundle_max_items`, and the overflow follows
//   * a double spend inside one bundling window is refused at enqueue
//   * a proof bound to this relayer's Bundler cannot be submitted through
//     another Bundler
//   * a fresh wallet recovers balances from a multi-operation transaction
//
// A hold stops every submission on the chain, for every file, so each case
// releases in a `finally` and `afterEach` releases again.

import { ethers } from "ethers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
    AssetId,
    CircuitAmount,
    SwapResult,
    TransactionResult,
    TransferResult,
    WalletApi,
    WithdrawResult,
} from "@lelantos-org/sdk";
import { evmAddress } from "@lelantos-org/sdk";
import { HttpRelayerSubmitter, type Submitter } from "@lelantos-org/sdk/advanced";
import type { Field } from "@lelantos-org/sdk/primitives";
import { SnarkjsProver } from "@lelantos-org/sdk/prover";

import { OTHER_BUNDLER_OWNER, RELAYER } from "../src/accounts.js";
import { env } from "../src/env.js";
import {
    amt,
    ASSET,
    ASSETS,
    awaitBalance,
    awaitOwn,
    awaitRecipient,
    baseAmt,
    type BundleItem,
    type BundleItemKind,
    bundleOutcome,
    BUNDLER_ABI,
    BUNDLER_FACTORY_ABI,
    buildDirectDeposit,
    cancelDepositAfterDelay,
    cmToHex,
    counter,
    createTestWallet,
    type Erc20Helpers,
    errorText,
    expectLeafInItem,
    expectRelayerPaid,
    expectRevert,
    FEE_HEADROOM,
    feeFor,
    type Harness,
    isEscrowed,
    LEAVES_PER_DEPOSIT,
    makeWallet,
    MASP_ABI,
    MASP_TRANSFER_ABI,
    N_OUT,
    newAuxRng,
    type QueuedOp,
    quoteDepositFee,
    RelayerHooks,
    relayerFeeNote,
    REVERT,
    shieldedBalance,
    spendItem,
    submitDepositDirect,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    txBundleItems,
    waitForBatchFlushTx,
    withFee,
} from "../src/harness.js";
import { once, setupFile } from "../src/fixture.js";
import {
    expectSwapEscrowCredited,
    quoteTestSwap,
    ROUTER_OUT,
    setMockNextOut,
    setupSwapVenue,
    SWAP_ASSET_OUT,
    SWAP_PUBLIC_OUT,
    WRAPPER_AMOUNT_IN,
} from "../src/swap-harness.js";
import { PROVER_PATHS } from "../src/testkit/prover.js";
import { TIMEOUT } from "../src/testkit/timeouts.js";
import { pollUntil } from "../src/utils.js";

const NSK = TEST_NSK.bundlerMixed;
const ASSET_WETH = ASSETS.WETH;
const ASSET_OUT = SWAP_ASSET_OUT;

/** What every spending wallet here deposits, unless its case says otherwise. */
const DEPOSIT = 40n;
const TO_BOB = 10n;
/** Gross `publicOut`, as in `full-flow`: the recipient gets it less the fee. */
const WITHDRAW = 10n;
const DEPOSIT_WETH = 20n;
const WITHDRAW_WETH = 8n;
/**
 * Gas for a hand-sent `Bundler.execute` of one spend. A bundled transfer uses
 * roughly 0.65–1.2M on this stack; the ceiling leaves room without reaching the
 * block limit (anvil runs with `--gas-limit=5000000000`).
 */
const ITEM_GAS_LIMIT = 5_000_000n;

/** One direct deposit's principal, for the flush the mixed bundle carries. */
const FLUSHED = 10n;
/** How many direct deposits the mixed bundle's flush is offered. */
const FLUSH_N = 4;

/** The swap's note: its `gross` (as in `tests/swap.test.ts`) plus relayer-fee headroom. */
const SWAP_DEPOSIT = SWAP_PUBLIC_OUT + FEE_HEADROOM;

/**
 * The relayer's deadline on a request/response route, `REQUEST_TIMEOUT` in
 * `vendor/backend/crates/relayer/src/handlers/http/router.rs`. Hardcoded
 * there, not in `config/relayer.toml`. Past it the relayer answers 503.
 */
const RELAYER_REQUEST_TIMEOUT_MS = 180_000;

/**
 * Submits stay open for as long as a case holds the batcher, which with
 * several wallets proving runs past the SDK's 30s default. See
 * `CreateWalletOpts.submitTimeoutMs`.
 *
 * Set past the relayer's own deadline, so the client never abandons a request
 * the relayer is still holding. That makes the relayer's deadline the per-
 * attempt bound. The SDK retries a submit's 503 (up to 3 times, under the same
 * idempotency key, which the relayer can fold into the original run), so a held
 * window past it costs retries rather than failing outright; the case fails
 * only if every attempt does. Fitting a held window inside
 * `RELAYER_REQUEST_TIMEOUT_MS` keeps the case off that path.
 */
const SUBMIT_TIMEOUT_MS = RELAYER_REQUEST_TIMEOUT_MS + TIMEOUT.HTTP_MS;

/**
 * How long a held case waits for one operation to reach the queue: its proof
 * and then its submit. Longer than the relayer's deadline because the proof
 * comes first and holds no request open; once an earlier spend's request is
 * open, that deadline cuts in first and `queuedWhileHeld` reports it.
 */
const QUEUE_TIMEOUT_MS = 240_000;

/** The mixed bundle's five operations must fit in one transaction. */
const MIXED_ITEMS = 5;

describe("bundler: mixed bundles through the relayer's Bundler", () => {
    let h: Harness;
    let mDai: Erc20Helpers;
    let hooks: RelayerHooks;
    const rng = counter(0xb1_de90_0001n);
    const auxRng = newAuxRng(0xb1_add_0001n);
    const rngs = { rng, auxRng };

    /** The bundle cap the relayer runs with. */
    const K = env.bundleMaxItems;

    beforeAll(async () => {
        const f = await setupFile({
            fund: [
                // Every deposit below, with room for each one's relayer fee.
                { asset: ASSET, amount: withFee(3_000n + BigInt(K + 2) * (DEPOSIT + FEE_HEADROOM)) },
                { asset: ASSET_WETH, amount: withFee(DEPOSIT_WETH + FEE_HEADROOM, ASSET_WETH) },
            ],
        });
        ({ h } = f);
        mDai = f.token(ASSET);
        hooks = new RelayerHooks(env.relayerUrl, env.chainId);
        // A hold left by an earlier run against a kept-alive stack would stall
        // the funding deposits below.
        await hooks.release();
    });

    afterEach(async () => {
        await hooks.release();
    });

    /**
     * A wallet whose submits outlive a hold, proving with snarkjs.
     *
     * Not the default WASM prover, whose `prove` runs synchronously on the main
     * thread against a shared thread pool: in full-suite runs, several wallets
     * proving while earlier submits were held stalled with proofs unfinished and
     * the fork idle. snarkjs proves asynchronously, off the main thread.
     */
    const wallet = (nsk: Field, opts: { submitter?: Submitter } = {}) =>
        createTestWallet(nsk, { submitTimeoutMs: SUBMIT_TIMEOUT_MS, prover: new SnarkjsProver(PROVER_PATHS), ...opts });

    /**
     * Deposit into each wallet, one submit at a time, and wait for all of them
     * to land.
     *
     * One at a time because SDK deposits share the payer's nonce; the waits run
     * together because they only read.
     */
    async function fund(entries: [WalletApi, AssetId, CircuitAmount][]): Promise<void> {
        const landed: Promise<void>[] = [];
        for (const [w, asset, amount] of entries) {
            const r = await w.deposit({ amount, asset });
            landed.push(fire(awaitOwn(w, r)));
        }
        await Promise.all(landed);
    }

    /**
     * Wait for the queue to satisfy `predicate` while `pending` are held.
     *
     * An operation settling first is a failure either way — resolving means it
     * was not held, rejecting means it never queued — and waiting out the
     * queue's timeout would only hide which.
     */
    async function queuedWhileHeld(
        pending: readonly Promise<unknown>[],
        predicate: (ops: QueuedOp[]) => boolean,
        label: string,
    ): Promise<QueuedOp[]> {
        const early = Promise.race(
            pending.map((p) =>
                p.then(
                    () => {
                        throw new Error(`${label}: an operation completed while the batcher was held`);
                    },
                    (e: unknown) => {
                        const why = e instanceof Error ? errorText(e) : String(e);
                        throw new Error(`${label}: an operation failed before it queued: ${why}`, {
                            cause: e,
                        });
                    },
                ),
            ),
        );
        early.catch(() => undefined);
        return Promise.race([hooks.waitQueued(predicate, QUEUE_TIMEOUT_MS, label), early]);
    }

    /** The mixed bundle: a flush of direct deposits and one spend of every kind. */
    const mixed = once(async () => {
        const alice = await wallet(NSK.alice);
        const bob = await wallet(NSK.bob);
        const carol = await wallet(NSK.carol);
        const dave = await wallet(NSK.dave);
        const erin = await wallet(NSK.erin);
        await fund([
            [alice, ASSET, amt(DEPOSIT)],
            [carol, ASSET, amt(DEPOSIT)],
            [dave, ASSET_WETH, amt(DEPOSIT_WETH)],
            [erin, ASSET, amt(SWAP_DEPOSIT)],
        ]);

        // The swap's venue: output liquidity, a quote, and a fixed fill.
        const s = await setupSwapVenue(h.payer);
        const quote = await quoteTestSwap(erin);
        expect(quote.net.baseUnits, "what the wrapper will receive").toBe(WRAPPER_AMOUNT_IN);
        await setMockNextOut(h.payer, s, ROUTER_OUT);

        // Fresh recipients, so each payout is the whole of its balance.
        const carolTo = evmAddress(ethers.Wallet.createRandom().address);
        const daveTo = evmAddress(ethers.Wallet.createRandom().address);

        // Built before the hold: draws stay sequential, and the hold is kept
        // as short as the proving allows.
        const sink = makeWallet(h.P, h.J, NSK.sink);
        const feeValue = await quoteDepositFee(h.relayer, env.chainId, ASSET);
        const builts = Array.from({ length: FLUSH_N }, () =>
            buildDirectDeposit(h, {
                amount: FLUSHED,
                recipient: sink.recipient,
                rngs,
                fee: (r) => relayerFeeNote(h.J, feeValue, r),
            }),
        );

        await hooks.hold();
        try {
            // In parallel so they land in one block and one flush tick picks
            // them all up. A tick that caught only some still makes a valid
            // flush item; the assertions follow whatever it queued.
            const noncedPayer = new ethers.NonceManager(h.payer);
            const deposits = await Promise.all(
                builts.map((b) => submitDepositDirect(h, b, { payer: noncedPayer })),
            );
            const ours = new Set(deposits.map((d) => d.depositId.toString()));
            const [flushOp] = await hooks.waitQueued(
                (ops) => ops.length === 1 && ops[0].kind === "flush",
                TIMEOUT.BATCH_FLUSH_MS,
                "the flush queued",
            );
            expect(flushOp.depositIds.every((id) => ours.has(String(id))), "the flush carries only our deposits")
                .toBe(true);

            // One at a time, each queued before the next is proved, so the queue
            // order is known. The swap goes first, so the batcher's "swaps
            // last" ordering has something to reorder.
            const pending: Promise<unknown>[] = [];
            // Returns once `p` is queued, not once it lands; the caller keeps
            // `p` to await after the release.
            const queue = async (p: Promise<unknown>, label: string): Promise<void> => {
                pending.push(fire(p));
                const want = pending.length + 1;
                await queuedWhileHeld(pending, (ops) => ops.length === want, `${label} queued`);
            };
            const swap = erin.swap({ quote });
            await queue(swap, "swap");
            const transfer = alice.transfer({ recipient: bob.address, amount: amt(TO_BOB), asset: ASSET });
            await queue(transfer, "transfer");
            const withdraw = carol.withdraw({ recipient: carolTo, gross: amt(WITHDRAW), asset: ASSET });
            await queue(withdraw, "withdraw");
            const withdrawNative = dave.withdraw({
                recipient: daveTo,
                gross: amt(WITHDRAW_WETH),
                asset: ASSET_WETH,
                native: true,
            });
            await queue(withdrawNative, "withdrawNative");
            const queued = await hooks.queue();
            expect(queued.map((o) => o.kind), "queue order").toEqual([
                "flush", "swap", "transfer", "withdraw", "withdrawNative",
            ]);
            await hooks.release();

            const [rT, rW, rN, rS] = await Promise.all([transfer, withdraw, withdrawNative, swap]);
            return {
                alice, bob, carol, dave, erin, carolTo, daveTo, builts, deposits, queued,
                rT: rT as TransferResult, rW: rW as WithdrawResult, rN: rN as WithdrawResult, rS: rS as SwapResult,
            };
        } finally {
            await hooks.release();
        }
    });

    it("publishes its Bundler, not its signing key, as relayerAddress", async () => {
        const { chains } = await h.relayer.getChains();
        const chain = chains.find((c) => BigInt(c.chainId) === env.chainId);
        expect(chain?.relayerAddress.toLowerCase()).toBe(env.bundlerAddress.toLowerCase());
        expect(chain?.relayerAddress.toLowerCase()).not.toBe(RELAYER.address.toLowerCase());
    }, TEST_TIMEOUT.LOCAL);

    it.skipIf(!env.swapEnabled || !env.nativeAdapterAddress || K < MIXED_ITEMS)(
        "lands a flush, a transfer, a withdraw, a native withdraw and a swap in one transaction",
        async () => {
            const m = await mixed();
            const { rT, rW, rN, rS, queued } = m;

            // One transaction, sent to the Bundler, which ran every operation.
            for (const r of [rW, rN, rS]) expect(r.txHash, `${r.kind} shares the bundle`).toBe(rT.txHash);
            const { receipt, items } = await txBundleItems(h.provider, rT.txHash);
            expect(receipt.to?.toLowerCase(), "sent to the Bundler").toBe(env.bundlerAddress.toLowerCase());
            expect(bundleOutcome(receipt, env.bundlerAddress))
                .toEqual({ executed: BigInt(MIXED_ITEMS), total: BigInt(MIXED_ITEMS) });

            // Queue order, except that the swap, queued second, goes last.
            expect(items.map((i) => i.kind), "execution order").toEqual([
                "flush", "transfer", "withdraw", "withdrawNative", "swap",
            ]);

            // Each operation's leaves, and together all of the block's.
            const [flush] = items;
            expect(flush.depositIds.map(String)).toEqual(queued[0].depositIds.map(String));
            expect(flush.inserted).toBe(BigInt(LEAVES_PER_DEPOSIT * flush.depositIds.length));
            expect(flush.cms, "each deposit's own note").toEqual(
                flush.depositIds.map((id) => {
                    const k = m.deposits.findIndex((d) => d.depositId === id);
                    return cmToHex(m.builts[k].cm);
                }),
            );
            const count = async (blockTag: number) =>
                (await h.masp.committedCount({ blockTag })) as bigint;
            expect(
                (await count(receipt.blockNumber)) - (await count(receipt.blockNumber - 1)),
                "the block's leaves are the bundle's",
            ).toBe(BigInt(LEAVES_PER_DEPOSIT * flush.depositIds.length + 4 * N_OUT));

            const byKind = async <R extends TransactionResult & { commitments: string[] }>(
                r: R,
                kind: BundleItemKind,
            ): Promise<BundleItem> => {
                const item = await spendItem(h.provider, r);
                expect(item.kind, `${kind}'s item`).toBe(kind);
                expect(item.inserted).toBe(BigInt(N_OUT));
                const op = queued.find((o) => o.kind === kind)!;
                expect(item.nullifiers.map(BigInt), `${kind}'s nullifiers are the ones it queued with`)
                    .toEqual(op.nullifiers.map(BigInt));
                return item;
            };
            const tItem = await byKind(rT, "transfer");
            const wItem = await byKind(rW, "withdraw");
            const nItem = await byKind(rN, "withdrawNative");
            const sItem = await byKind(rS, "swap");

            // Public payouts, read off each operation and off the chain.
            const netW = baseAmt(WITHDRAW) - feeFor(WITHDRAW);
            expect(wItem.assetMoved?.publicOut).toBe(WITHDRAW);
            expect(await mDai.balanceOf(m.carolTo), "carol's recipient").toBe(netW);

            const netN = baseAmt(WITHDRAW_WETH, ASSET_WETH) - feeFor(WITHDRAW_WETH, ASSET_WETH);
            expect(nItem.assetMoved?.publicOut).toBe(WITHDRAW_WETH);
            expect((nItem.nativeWithdrawn?.recipient as string).toLowerCase()).toBe(m.daveTo.toLowerCase());
            expect(nItem.nativeWithdrawn?.amount).toBe(netN);
            expect(await h.provider.getBalance(m.daveTo), "dave's recipient, in coin").toBe(netN);

            expect(sItem.swapExecuted?.amountIn).toBe(WRAPPER_AMOUNT_IN);
            expect(sItem.swapExecuted?.actualOut).toBe(ROUTER_OUT);
            expect(sItem.swapExecuted?.depositId).toBe(sItem.escrowedDepositId);

            // Every note reaches its wallet at a leaf its own operation wrote.
            await Promise.all([
                awaitOwn(m.alice, rT),
                awaitRecipient(m.bob, rT),
                awaitOwn(m.carol, rW),
                awaitOwn(m.dave, rN),
                awaitOwn(m.erin, rS),
            ]);
            for (const cm of rT.ownCommitments) expectLeafInItem(m.alice, cm, tItem);
            expectLeafInItem(m.bob, rT.recipientCommitment, tItem);
            for (const cm of rW.ownCommitments) expectLeafInItem(m.carol, cm, wItem);
            for (const cm of rN.ownCommitments) expectLeafInItem(m.dave, cm, nItem);
            for (const cm of rS.ownCommitments) expectLeafInItem(m.erin, cm, sItem);

            // Each spend paid its own fee, out of its own inputs.
            const feeT = await expectRelayerPaid(rT, ASSET);
            const feeW = await expectRelayerPaid(rW, ASSET);
            const feeN = await expectRelayerPaid(rN, ASSET_WETH);
            const feeS = await expectRelayerPaid(rS, ASSET);
            expect(await shieldedBalance(m.alice, ASSET)).toBe(DEPOSIT - TO_BOB - feeT);
            expect(await shieldedBalance(m.bob, ASSET)).toBe(TO_BOB);
            expect(await shieldedBalance(m.carol, ASSET)).toBe(DEPOSIT - WITHDRAW - feeW);
            expect(await shieldedBalance(m.dave, ASSET_WETH)).toBe(DEPOSIT_WETH - WITHDRAW_WETH - feeN);
            expect(rS.gross.amount).toBe(SWAP_PUBLIC_OUT);
            expect(await shieldedBalance(m.erin, ASSET)).toBe(SWAP_DEPOSIT - SWAP_PUBLIC_OUT - feeS);

            // The swap's output was escrowed inside the bundle and is flushed by
            // a later operation, into a note erin can see.
            const executed = sItem.swapExecuted;
            if (executed === undefined) throw new Error(`${rT.txHash}: the swap item carries no SwapExecuted`);
            const later = await waitForBatchFlushTx(h, {
                fromBlock: receipt.blockNumber,
                wantedIds: [executed.depositId as bigint],
            });
            expect(later.txHash, "flushed after the bundle, not in it").not.toBe(rT.txHash);
            // erin is fresh, so her whole output-asset balance is this note.
            await expectSwapEscrowCredited(h.provider, {
                txHash: rT.txHash,
                event: executed,
                available: executed.actualOut as bigint,
                asset: ASSET_OUT,
                credited: await awaitBalance(m.erin, ASSET_OUT),
            });

            await expectExplorerRows(rT.txHash, items);
        },
        TEST_TIMEOUT.SEQUENCE,
    );

    /**
     * The explorer lists one row per operation, each at a log inside that
     * operation and of its kind.
     *
     * Pending rows are left out: the swap's output deposit is listed as
     * pending under this transaction only until its flush lands.
     */
    async function expectExplorerRows(txHash: string, items: BundleItem[]): Promise<void> {
        const explorerKind: Record<BundleItemKind, string> = {
            flush: "deposit",
            transfer: "transfer",
            withdraw: "withdraw",
            withdrawNative: "withdraw",
            swap: "withdraw",
        };
        const rowsPerItem = (i: BundleItem) => (i.kind === "flush" ? i.depositIds.length : 1);
        const want = items.reduce((n, i) => n + rowsPerItem(i), 0);
        const strip = (hash: string) => hash.toLowerCase().replace(/^0x/, "");

        const rows = await pollUntil(
            async (signal) => {
                const res = await fetch(
                    `${env.explorerUrl}/v1/transactions?chainId=${env.chainId}&sinceTs=0&limit=1000`,
                    { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT.HTTP_MS)]) },
                );
                if (!res.ok) throw new Error(`explorer: ${res.status} ${await res.text()}`);
                const all = (await res.json()) as { txHashHex: string; logIndex: number | null; kind: string }[];
                const mine = all.filter((r) => strip(r.txHashHex) === strip(txHash) && r.kind !== "pending");
                if (mine.length > want) throw new Error(`explorer: ${mine.length} rows, want ${want}`);
                return mine.length === want ? mine : null;
            },
            { label: `explorer rows for ${txHash}`, timeoutMs: TIMEOUT.POLL_DEFAULT_MS, intervalMs: 2_000 },
        );

        for (const item of items) {
            const [first, last] = item.logRange;
            const inside = rows.filter((r) => r.logIndex !== null && r.logIndex >= first && r.logIndex <= last);
            expect(inside.map((r) => r.kind), `explorer rows for item ${item.index} (${item.kind})`)
                .toEqual(Array(rowsPerItem(item)).fill(explorerKind[item.kind]));
        }
    }

    it.skipIf(!env.swapEnabled || !env.nativeAdapterAddress || K < MIXED_ITEMS)(
        "a fresh wallet recovers every balance from the mixed bundle",
        async () => {
            const m = await mixed();
            // The live wallets have seen the swap's output by now only if the
            // mixed case ran; sync them rather than rely on it.
            await awaitBalance(m.erin, ASSET_OUT);
            for (const [name, live] of Object.entries({
                alice: m.alice, bob: m.bob, carol: m.carol, dave: m.dave, erin: m.erin,
            }) as [keyof typeof NSK, WalletApi][]) {
                await live.sync({ pageSize: SYNC_LIMIT });
                const cold = await createTestWallet(NSK[name]);
                await cold.sync({ pageSize: SYNC_LIMIT });
                for (const asset of [ASSET, ASSET_WETH, ASSET_OUT]) {
                    expect(await shieldedBalance(cold, asset), `${name}: asset ${asset}`)
                        .toBe(await shieldedBalance(live, asset));
                }
                expect(
                    (await cold.notes({ spent: false })).map((n) => n.cm).sort(),
                    `${name}: the same unspent notes`,
                ).toEqual((await live.notes({ spent: false })).map((n) => n.cm).sort());
            }
        },
        TEST_TIMEOUT.SEQUENCE,
    );

    it("drops a flush whose deposit was cancelled while held, and bundles the transfers around it", async () => {
        const frank = await wallet(NSK.frank);
        const grace = await wallet(NSK.grace);
        await fund([
            [frank, ASSET, amt(DEPOSIT)],
            [grace, ASSET, amt(DEPOSIT)],
        ]);
        const sink = makeWallet(h.P, h.J, NSK.sink);
        const feeValue = await quoteDepositFee(h.relayer, env.chainId, ASSET);
        const built = buildDirectDeposit(h, {
            amount: FLUSHED,
            recipient: sink.recipient,
            rngs,
            fee: (r) => relayerFeeNote(h.J, feeValue, r),
        });
        const startBlock = await h.provider.getBlockNumber();

        await hooks.hold();
        let r1: TransferResult;
        let r2: TransferResult;
        let depositId: bigint;
        try {
            const t1 = fire(frank.transfer({ recipient: grace.address, amount: amt(TO_BOB), asset: ASSET }));
            await queuedWhileHeld([t1], (ops) => ops.length === 1 && ops[0].kind === "transfer", "T1 queued");

            // Pays the relayer, so the flush worker queues it like any other.
            const x = await submitDepositDirect(h, built);
            depositId = x.depositId;
            await queuedWhileHeld(
                [t1],
                (ops) => ops.length === 2 && ops[1].kind === "flush" && ops[1].depositIds.map(String).includes(String(x.depositId)),
                "the flush of X queued behind T1",
            );

            const t2 = fire(grace.transfer({ recipient: frank.address, amount: amt(TO_BOB), asset: ASSET }));
            await queuedWhileHeld([t1, t2], (ops) => ops.length === 3 && ops[2].kind === "transfer", "T2 queued");

            // The flush was valid when it queued and is not any more.
            await cancelDepositAfterDelay(h, x.txHash);
            await hooks.release();
            [r1, r2] = (await Promise.all([t1, t2])) as [TransferResult, TransferResult];
        } finally {
            await hooks.release();
        }

        expect(r2.txHash, "T1 and T2 share a transaction").toBe(r1.txHash);
        const { receipt, items } = await txBundleItems(h.provider, r1.txHash);
        expect(items.map((i) => i.kind), "the flush was dropped before sending").toEqual(["transfer", "transfer"]);
        expect(bundleOutcome(receipt, env.bundlerAddress), "nothing stopped on chain")
            .toEqual({ executed: 2n, total: 2n });

        // X never entered the tree, and its escrow went back to the payer.
        expect(await isEscrowed(h.provider, depositId), "X's escrow slot is cleared").toBe(false);
        const flushedX = await h.provider.getLogs({
            address: env.maspAddress,
            topics: [h.masp.interface.getEvent("DepositFlushed")!.topicHash, ethers.toBeHex(depositId, 32)],
            fromBlock: startBlock,
            toBlock: "latest",
        });
        expect(flushedX, "X was never flushed").toHaveLength(0);

        await Promise.all([awaitOwn(frank, r1), awaitRecipient(grace, r1)]);
        await Promise.all([awaitOwn(grace, r2), awaitRecipient(frank, r2)]);
        const fee1 = await expectRelayerPaid(r1, ASSET);
        const fee2 = await expectRelayerPaid(r2, ASSET);
        expect(await shieldedBalance(frank, ASSET)).toBe(DEPOSIT - fee1);
        expect(await shieldedBalance(grace, ASSET)).toBe(DEPOSIT - fee2);
    }, TEST_TIMEOUT.SEQUENCE);

    it(`never puts more than bundle_max_items operations in one transaction`, async () => {
        const n = K + 2;
        const senders: WalletApi[] = [];
        for (let i = 0; i < n; i++) senders.push(await wallet(TEST_NSK.bundlerCap.base + BigInt(i)));
        await fund(senders.map((w) => [w, ASSET, amt(DEPOSIT)]));

        await hooks.hold();
        let results: TransferResult[];
        try {
            // Around a ring, so every sender is also a recipient and no case
            // elsewhere sees these notes. One proof at a time, each queued
            // before the next starts, so the queue fills in a known order.
            const pending: Promise<TransactionResult>[] = [];
            for (const [i, w] of senders.entries()) {
                pending.push(fire(w.transfer({ recipient: senders[(i + 1) % n].address, amount: amt(TO_BOB), asset: ASSET })));
                await queuedWhileHeld(pending, (ops) => ops.length === i + 1, `transfer ${i + 1} of ${n} queued`);
            }
            const queued = await hooks.queue();
            expect(queued.map((o) => o.kind)).toEqual(Array(n).fill("transfer"));
            await hooks.release();
            results = (await Promise.all(pending)) as TransferResult[];
        } finally {
            await hooks.release();
        }

        const byTx = new Map<string, TransferResult[]>();
        for (const r of results) byTx.set(r.txHash, [...(byTx.get(r.txHash) ?? []), r]);
        const sizes: number[] = [];
        for (const [txHash, rs] of byTx) {
            const { receipt, items } = await txBundleItems(h.provider, txHash);
            expect(items.length, `${txHash} is within the cap`).toBeLessThanOrEqual(K);
            expect(bundleOutcome(receipt, env.bundlerAddress)).toEqual({
                executed: BigInt(items.length),
                total: BigInt(items.length),
            });
            // Nothing else shared these transactions: every item is one of ours.
            expect(items.length).toBe(rs.length);
            for (const r of rs) {
                expect((await spendItem(h.provider, r)).kind, `${txHash} carries each of its results as a transfer`)
                    .toBe("transfer");
            }
            sizes.push(items.length);
        }
        // All `n` were queued at release, so the batcher cuts full bundles of
        // `K` and the remainder follows.
        const want = Array.from({ length: Math.ceil(n / K) }, (_, i) => Math.min(K, n - i * K));
        expect(sizes.sort((a, b) => b - a), "bundle sizes").toEqual(want);

        await Promise.all(senders.map((w, i) => awaitOwn(w, results[i])));
    }, TEST_TIMEOUT.SEQUENCE);

    it("refuses a double spend at enqueue while held, and bundles the rest", async () => {
        const heidi = await wallet(NSK.heidi);
        // A second handle on heidi's keys that never learns of her first spend,
        // so it picks the same note again: a wallet that had seen the spend
        // would refuse locally and never reach the relayer.
        const stale = await wallet(NSK.heidi);
        const ivan = await wallet(NSK.ivan);
        const deposit = await heidi.deposit({ amount: amt(DEPOSIT), asset: ASSET });
        await Promise.all([awaitOwn(heidi, deposit), awaitOwn(stale, deposit)]);
        await fund([[ivan, ASSET, amt(DEPOSIT)]]);

        await hooks.hold();
        let winner: TransferResult;
        let other: TransferResult;
        try {
            // One proof at a time, each queued before the next is proved.
            const first = fire(heidi.transfer({ recipient: ivan.address, amount: amt(TO_BOB), asset: ASSET }));
            await queuedWhileHeld([first], (ops) => ops.length === 1, "heidi's spend queued");
            const third = fire(ivan.transfer({ recipient: heidi.address, amount: amt(TO_BOB), asset: ASSET }));
            await queuedWhileHeld([first, third], (ops) => ops.length === 2, "ivan's spend queued");

            // Nothing lands while held, so the replay settling at all means it
            // was refused before it could queue.
            await expectRevert(
                stale.transfer({ recipient: ivan.address, amount: amt(TO_BOB), asset: ASSET }),
                { code: "RELAYER_REJECTED", match: REVERT.NULLIFIER_REJECTED_AT_ENQUEUE },
            );
            const queued = await hooks.queue();
            expect(queued.map((o) => o.kind), "the replay did not queue").toEqual(["transfer", "transfer"]);
            const [a, b] = queued.map((o) => new Set(o.nullifiers.map((nf) => BigInt(nf).toString())));
            expect([...a].filter((nf) => b.has(nf)), "no nullifier is queued twice").toEqual([]);

            await hooks.release();
            [winner, other] = (await Promise.all([first, third])) as [TransferResult, TransferResult];
        } finally {
            await hooks.release();
        }

        expect(other.txHash, "the rest still share a bundle").toBe(winner.txHash);
        const { receipt, items } = await txBundleItems(h.provider, winner.txHash);
        expect(items.map((i) => i.kind)).toEqual(["transfer", "transfer"]);
        expect(bundleOutcome(receipt, env.bundlerAddress)).toEqual({ executed: 2n, total: 2n });

        await Promise.all([awaitOwn(heidi, winner), awaitRecipient(ivan, winner)]);
        await Promise.all([awaitOwn(ivan, other), awaitRecipient(heidi, other)]);
        // One of heidi's spends landed: one fee, and ivan credited once.
        const feeH = await expectRelayerPaid(winner, ASSET);
        const feeI = await expectRelayerPaid(other, ASSET);
        expect(await shieldedBalance(heidi, ASSET), "heidi's note spent once").toBe(DEPOSIT - TO_BOB - feeH + TO_BOB);
        expect(await shieldedBalance(ivan, ASSET), "ivan credited once").toBe(DEPOSIT - TO_BOB - feeI + TO_BOB);
    }, TEST_TIMEOUT.SEQUENCE);

    it("reverts BadRelayer for a proof bound to this relayer's Bundler sent through another Bundler", async () => {
        // A wallet that proves as usual and hands the payload to the test
        // instead of the relayer.
        const capture = new CapturingSubmitter(env.relayerUrl, { timeoutMs: SUBMIT_TIMEOUT_MS });
        const judy = await wallet(NSK.judy, { submitter: capture });
        await fund([[judy, ASSET, amt(DEPOSIT)]]);
        await expectRevert(
            judy.transfer({ recipient: judy.address, amount: amt(TO_BOB), asset: ASSET }),
            CapturingSubmitter.CAPTURED,
        );
        const payload = capture.payload!;
        expect(payload.pubInputs.relayer.toLowerCase(), "bound to the stack's Bundler")
            .toBe(env.bundlerAddress.toLowerCase());

        // A second Bundler, owned and operated by an account no relayer uses.
        // The factory fixes its targets, so it may call the pool like the
        // stack's own.
        const owner = new ethers.Wallet(OTHER_BUNDLER_OWNER.privateKey, h.provider);
        const factory = new ethers.Contract(env.bundlerFactoryAddress, BUNDLER_FACTORY_ABI, owner);
        const otherAddress = (await factory.predict(owner.address)) as string;
        // One Bundler per owner, so a rerun against a kept-alive stack reuses it.
        if ((await h.provider.getCode(otherAddress)) === "0x") {
            await (await factory.create([owner.address])).wait();
        }
        expect(otherAddress.toLowerCase()).not.toBe(env.bundlerAddress.toLowerCase());

        const call = { target: env.maspAddress, data: await transferCalldata(payload) };

        const other = new ethers.Contract(otherAddress, BUNDLER_ABI, owner);
        // An explicit limit, not ethers' estimate. `Bundler.execute` never
        // reverts when an item fails — it records `BundleItemFailed` and
        // returns — so `eth_estimateGas` converges on the least gas at which
        // the *outer* call succeeds, which starves the item: it then fails as
        // `ItemOutOfGas` before the pool reaches the relayer-binding check this
        // case is about. The relayer has the same blind spot and handles it by
        // doubling the limit on `ItemOutOfGas`; a transfer here uses well under
        // this ceiling.
        const receipt = (await (await other.execute([call], { gasLimit: ITEM_GAS_LIMIT })).wait()) as
            ethers.TransactionReceipt;
        const outcome = bundleOutcome(receipt, otherAddress);
        expect({ executed: outcome.executed, total: outcome.total }).toEqual({ executed: 0n, total: 1n });
        expect(errorText(Object.assign(new Error("BundleItemFailed"), { data: outcome.failed?.reason })))
            .toMatch(REVERT.BAD_RELAYER);

        // The control: the same call through the relayer's own Bundler, from its
        // operator, gets past the binding check and fails later, on the
        // placeholder tree-update proof. Simulated, so the relayer's nonce is
        // untouched.
        const own = new ethers.Contract(
            env.bundlerAddress,
            BUNDLER_ABI,
            new ethers.Wallet(RELAYER.privateKey, h.provider),
        );
        const [executed, reason] = (await own.execute.staticCall([call])) as [bigint, string];
        expect(executed).toBe(0n);
        expect(reason, "the item failed for a reason").not.toBe("0x");
        expect(errorText(Object.assign(new Error("simulated"), { data: reason })), "not on the binding")
            .not.toMatch(REVERT.BAD_RELAYER);
    }, TEST_TIMEOUT.SEQUENCE);

    // Two relayers on one chain, each with its own signer (acct[4] for the
    // second) and its own Bundler from the factory, both holding, queueing
    // spends for their own wallets and releasing together: one bundle lands
    // first, the other resyncs and lands after, with no operation processed
    // twice. Not done here: the stack starts one relayer, and a second needs its
    // own container spec in `src/services.ts`, a config that shares postgres and
    // the fee identity without its flush worker racing the first one's for the
    // same deposits, and wallets pointed at its URL and Bundler. That is a
    // stack change, not a test.
    it.todo("two relayers release held bundles together; one lands, the other resyncs and lands after");

    /**
     * `MASP.transfer` calldata for a captured payload.
     *
     * The tree update is a placeholder shaped to pass every check before the
     * proofs are verified — the anchor's ring slot and the leaf count — so a
     * rejection before verification is about the request, not about the
     * placeholder. The pool rebuilds the rest of the tree-update image from
     * `pi` itself.
     */
    async function transferCalldata(p: CapturedPayload): Promise<string> {
        const pool = new ethers.Contract(env.maspAddress, [...MASP_TRANSFER_ABI, ...MASP_ABI], h.provider);
        const b32 = (v: bigint) => ethers.toBeHex(v, 32);
        const pt = (v: readonly [bigint, bigint]) => [v[0], v[1]];
        const pi = p.pubInputs;
        // `anchorIndex` is a lookup hint, not a public input: the ring slot the
        // pool compares `pi.merkleRoot` against. The anchor is already on chain.
        const [found, anchorIndex] = (await pool.rootIndexOf(b32(pi.merkleRoot))) as [boolean, bigint];
        if (!found) throw new Error(`anchor ${b32(pi.merkleRoot)} is not in the root ring`);
        return pool.interface.encodeFunctionData("transfer", [
            {
                a: [p.proof.piA[0], p.proof.piA[1]],
                // snarkjs orders each G2 coordinate low-then-high; the verifier
                // takes [imag, real]. As `build_proof` in the relayer.
                b: [
                    [p.proof.piB[0][1], p.proof.piB[0][0]],
                    [p.proof.piB[1][1], p.proof.piB[1][0]],
                ],
                c: [p.proof.piC[0], p.proof.piC[1]],
            },
            {
                merkleRoot: b32(pi.merkleRoot),
                nullifier: pi.nullifier.map(b32),
                outCm: pi.outCm.map(b32),
                publicAssetId: pi.publicAssetId,
                publicIn: pi.publicIn,
                publicOut: pi.publicOut,
                inCv: pi.inCv.map(pt),
                outCv: pi.outCv.map(pt),
                outCvDep: pi.outCvDep.map(pt),
                recipient: pi.recipient,
                chainId: pi.chainId,
                payer: pi.payer,
                relayer: pi.relayer,
                intentHash: pi.intentHash,
            },
            { a: [0, 0], b: [[0, 0], [0, 0]], c: [0, 0] },
            {
                newRoot: ethers.ZeroHash,
                startIndex: await pool.committedCount(),
                anchorIndex,
            },
            p.aux.map((a) => ({
                clueRx: a.clueR[0],
                clueRy: a.clueR[1],
                ephPubX: a.ephPub[0],
                ephPubY: a.ephPub[1],
                ciphertext: ethers.hexlify(a.ciphertext),
            })),
        ]);
    }
});

type CapturedPayload = Parameters<Submitter["submit"]>[0];

/** The default submitter, except that a spend is recorded and refused rather than sent. */
class CapturingSubmitter extends HttpRelayerSubmitter {
    static readonly CAPTURED = "payload captured, not submitted";
    payload?: CapturedPayload;

    override async submit(payload: CapturedPayload): ReturnType<Submitter["submit"]> {
        this.payload = payload;
        throw new Error(CapturingSubmitter.CAPTURED);
    }
}

/**
 * Keep a promise that is awaited later from reporting an unhandled rejection in
 * the meantime. The returned promise still rejects for whoever awaits it.
 */
function fire<T>(p: Promise<T>): Promise<T> {
    p.catch(() => undefined);
    return p;
}
