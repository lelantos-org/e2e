// Test waits driven by a `TransactionResult`: pick the poll shape from the tx
// kind and route the right commitments to the right wallet, so each call site
// stays one line.

import { ethers } from "ethers";

import type {
    AssetRef,
    CircuitAmount,
    TransactionResult,
    WalletApi,
} from "@lelantos-org/sdk";
import { walletInternals } from "@lelantos-org/sdk/internal";

import { MASP_ABI } from "./protocol/abi.js";
import { POLL, type PollOpts, SYNC_LIMIT, TIMEOUT } from "./testkit/timeouts.js";
import { watchDepositFlush } from "./deposit-flush.js";
import { env } from "./env.js";
import { recipientCommitments } from "./scenario.js";
import { mineIfAnvil, rpcProvider } from "./tx.js";
import { aborted, cmToHex, pollUntil } from "./utils.js";

/**
 * A deposit waits on the shielding flush window; spends are faster because the
 * relayer's spend pipeline is event-driven.
 */
function pollForKind(kind: TransactionResult["kind"]): PollOpts {
    return kind === "deposit" ? POLL.COMMITMENT : POLL.SPEND;
}

/**
 * Wait for the tx's own non-zero outputs to land in the sender's cache, then
 * sync the local Merkle tree so later spends have a valid root.
 */
export async function awaitOwn(
    w: WalletApi,
    r: TransactionResult,
    opts: PollOpts = pollForKind(r.kind),
): Promise<void> {
    await awaitCommitted(w, r, r.ownCommitments, opts);
    await w.sync({ scope: "full", pageSize: SYNC_LIMIT });
    await assertMerkleConsistency(w, r.ownCommitments);
    await advanceOneBlock();
}

/**
 * Wait for the tx's recipient-side commitments. Use on the counterparty wallet
 * (`bob` in a transfer).
 */
export async function awaitRecipient(
    w: WalletApi,
    r: TransactionResult,
    opts: PollOpts = pollForKind(r.kind),
): Promise<void> {
    const expected = recipientCommitments(r);
    await awaitCommitted(w, r, expected, opts);
    await w.sync({ scope: "full", pageSize: SYNC_LIMIT });
    await assertMerkleConsistency(w, expected);
    await advanceOneBlock();
}

/**
 * Wait for `cms` to reach `w`'s note cache, failing with a message naming the
 * stage that stalled.
 *
 * For a deposit the poll spans two services, the relayer's flush and the
 * indexer's pickup, so a bare timeout cannot say which stalled. Watching the
 * flush event alongside it separates "the relayer never flushed" from "it
 * flushed and the indexer never surfaced the note".
 *
 * The SDK's wait checks its clock and its signal only between syncs, and hands
 * the sync itself no signal, so a sync that never returns would hold the wait
 * forever. Racing the call against the abort is what bounds it; the abandoned
 * sync is left to finish or hang in the background.
 */
async function awaitCommitted(
    w: WalletApi,
    r: TransactionResult,
    cms: string[],
    opts: PollOpts,
): Promise<void> {
    // Watched concurrently and never awaited before the poll: the flush only
    // explains a failure, so blocking on it would put an advisory signal on the
    // critical path and charge every deposit its timeout whenever an event is
    // missed.
    const watch = r.kind === "deposit" ? watchDepositFlush(r.escrow.depositId) : undefined;
    // A little past the SDK's own deadline, so its `timeout` result, which
    // names the missing commitments, wins over the abort whenever syncs return.
    const signal = AbortSignal.timeout(opts.timeoutMs + opts.pollMs + TIMEOUT.HTTP_MS);

    try {
        const wait = w.awaitCommitments(cms, {
            pageSize: SYNC_LIMIT,
            pollMs: opts.pollMs,
            timeoutMs: opts.timeoutMs,
            signal,
        });
        // A wait that loses the race can still reject later.
        wait.catch(() => undefined);
        const seen = await Promise.race([wait, aborted(signal)])
            .catch(async (e: unknown) => {
                if (!signal.aborted) throw e;
                const stage = watch ? ` — ${await watch.explain()}` : "";
                throw new Error(
                    `${r.kind} ${r.txHash}: a sync was still running when the ` +
                        `${opts.timeoutMs}ms wait for ${cms.length} commitments ran out${stage}`,
                    { cause: e },
                );
            });
        if (seen.missing.length === 0) return;

        const stage = watch ? ` — ${await watch.explain()}` : "";
        throw new Error(
            `${r.kind} ${r.txHash}: ${seen.missing.length}/${cms.length} commitments never ` +
                `reached the note cache within ${opts.timeoutMs}ms (${seen.attempts} syncs, ` +
                `${seen.status})${stage}. missing: ${seen.missing.join(", ")}`,
        );
    } finally {
        watch?.close();
    }
}

let _provider: ethers.JsonRpcProvider | undefined;
let _masp: ethers.Contract | undefined;

function provider(): ethers.JsonRpcProvider {
    // `rpcProvider` disables ethers' 250ms `_perform` cache; see `tx.ts`.
    return (_provider ??= rpcProvider(env.rpcUrl));
}

function maspReader(): ethers.Contract {
    _masp ??= new ethers.Contract(env.maspAddress, MASP_ABI, provider());
    return _masp;
}

/**
 * Advance the chain once a note has landed.
 *
 * The SDK's coin selector will not spend a note until the tip has moved past
 * the block it was first seen in (`DEFAULT_COOLDOWN_BLOCKS`), since spending in
 * the same block is a linkability signal.
 *
 * Anvil runs with `--block-time=1` (see `ANVIL` in `services.ts`), so the tip
 * advances on its own, but a note landing in the newest block sits at
 * `tip - firstSeenBlock == 0` until the next interval elapses and a spend
 * issued in that window fails with "in spend cooldown". Mining explicitly makes
 * the advance immediate, so `awaitOwn` means "landed and spendable" when it
 * returns. The SDK's viem reader reads the tip with `cacheTime: 0`, so the
 * advance is visible to the selector at once.
 */
async function advanceOneBlock(): Promise<void> {
    await mineIfAnvil(provider(), 2);
}

/**
 * Cross-check the wallet's locally folded Merkle tree against the chain.
 *
 * The wallet never requests a path: it pages the commitment chunk feed and
 * folds the tree itself, so a fold bug (wrong leaf hash, wrong ordering, a
 * missed chunk) would otherwise surface only when the pool rejected the spend
 * proof several steps later, as `UnknownRoot` with no indication of which note
 * was wrong. This pins it at the point of insertion.
 *
 * The pool is the source of truth, and `isKnownRoot` is the predicate a spend
 * is checked against. It accepts any root in the ring, so a wallet trailing the
 * tip by a few advances still passes, which is normal while the indexer catches
 * up.
 *
 * Not a by-commitment lookup against the relayer: asking a server for the path
 * to a specific cm reveals which note is about to be spent, which is what the
 * chunk feed exists to avoid.
 *
 * Reads the stored notes and the tree through `walletInternals`: neither the
 * leaf index nor the path is on the wallet's public surface.
 */
export async function assertMerkleConsistency(w: WalletApi, cms: string[]): Promise<void> {
    const masp = maspReader();
    const internals = walletInternals(w);
    const notes = internals.file.notes;
    // Every path is read off the wallet's one synced tree, so the commitments
    // share a root even when a bundle advanced it several times in one tx.
    // Each distinct root is checked once rather than one eth_call per output.
    const checked = new Set<string>();
    for (const cm of cms) {
        const stored = notes.find((n) => n.cm === cm);
        if (!stored) throw new Error(`assertMerkleConsistency: note not found for cm=${cm}`);
        const rootHex = cmToHex(internals.treeStore.getPath(stored.leafIndex).root);
        if (checked.has(rootHex)) continue;
        checked.add(rootHex);
        if (!((await masp.isKnownRoot(rootHex)) as boolean)) {
            throw new Error(
                `local tree root ${rootHex} is not a known root on-chain ` +
                    `(cm=${cm}, leafIndex=${stored.leafIndex}) — the wallet's folded ` +
                    `tree disagrees with the pool`,
            );
        }
    }
}

/**
 * `w`'s unspent shielded balance of `asset`, in circuit units, as of its last
 * sync: every unspent note, whether or not one spend could reach it.
 *
 * Reads the local note cache only. A wallet that was never synced reports zero
 * whatever the chain holds, so an assertion that a wallet was *not* credited
 * must use `syncedBalance`, or it passes however many notes reached it.
 */
export async function shieldedBalance(w: WalletApi, asset: AssetRef): Promise<CircuitAmount> {
    return (await w.balance(asset)).total;
}

/**
 * `shieldedBalance` after a sync: what the chain says `w` holds now. Notes and
 * the spent set are enough for a balance, so the tree is left alone.
 */
export async function syncedBalance(w: WalletApi, asset: AssetRef): Promise<CircuitAmount> {
    await w.sync({ scope: "notes", pageSize: SYNC_LIMIT });
    return shieldedBalance(w, asset);
}

/**
 * Poll `sync()` until the wallet's balance for `asset` rises above `above`
 * (default zero), and return it.
 *
 * Used by the swap test: the relayer flushes the output-asset note, or a
 * refund note, asynchronously, so its commitment is in no `r.commitments`
 * returned to the caller.
 */
export async function awaitBalance(
    w: WalletApi,
    asset: bigint,
    opts: { above?: bigint; timeoutMs?: number; pollMs?: number; syncLimit?: number } = {},
): Promise<bigint> {
    const above = opts.above ?? 0n;
    const timeoutMs = opts.timeoutMs ?? TIMEOUT.BALANCE_POLL_MS;
    const pollMs = opts.pollMs ?? POLL.COMMITMENT.pollMs;
    const syncLimit = opts.syncLimit ?? SYNC_LIMIT;
    return pollUntil(
        async () => {
            await w.sync({ pageSize: syncLimit });
            const b = await shieldedBalance(w, asset);
            return b > above ? b : null;
        },
        { label: `balance(asset=${asset})`, timeoutMs, intervalMs: pollMs },
    );
}
