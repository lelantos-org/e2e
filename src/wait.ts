// Test waits driven by a `TransactionResult`: pick the poll shape from the tx
// kind and route the right commitments to the right wallet, so each call site
// stays one line.

import { ethers } from "ethers";

import { assetId, type TransactionResult, type Wallet } from "@lelantos-org/sdk";

import { MASP_ABI } from "./protocol/abi.js";
import { POLL, type PollOpts, SYNC_LIMIT, TIMEOUT, VIEM_BLOCK_CACHE_MS } from "./testkit/timeouts.js";
import { watchDepositFlush } from "./deposit-flush.js";
import { env } from "./env.js";
import { recipientCommitments } from "./scenario.js";
import { rpcProvider } from "./tx.js";
import { cmToHex, pollUntil } from "./utils.js";

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
    w: Wallet,
    r: TransactionResult,
    opts: PollOpts = pollForKind(r.kind),
): Promise<void> {
    await awaitCommitted(w, r, r.ownCommitments, opts);
    await w.treeStore.sync();
    await assertMerkleConsistency(w, r.ownCommitments);
    await advanceOneBlock();
}

/**
 * Wait for the tx's recipient-side commitments. Use on the counterparty wallet
 * (`bob` in a transfer).
 */
export async function awaitRecipient(
    w: Wallet,
    r: TransactionResult,
    opts: PollOpts = pollForKind(r.kind),
): Promise<void> {
    const expected = recipientCommitments(r);
    await awaitCommitted(w, r, expected, opts);
    await w.treeStore.sync();
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
 */
async function awaitCommitted(
    w: Wallet,
    r: TransactionResult,
    cms: string[],
    opts: PollOpts,
): Promise<void> {
    // Watched concurrently and never awaited before the poll: the flush only
    // explains a failure, so blocking on it would put an advisory signal on the
    // critical path and charge every deposit its timeout whenever an event is
    // missed.
    const watch =
        r.kind === "deposit" && r.depositId !== undefined
            ? watchDepositFlush(r.depositId)
            : undefined;

    try {
        const seen = await pollForCommitments(w, cms, opts);
        if (seen.missing.length === 0) return;

        const stage = watch ? ` — ${await watch.explain()}` : "";
        throw new Error(
            `${r.kind} ${r.txHash}: ${seen.missing.length}/${cms.length} commitments never ` +
                `reached the note cache after ${seen.attempts} attempts${stage}. ` +
                `missing: ${seen.missing.join(", ")}`,
        );
    } finally {
        watch?.close();
    }
}

/**
 * Poll a wallet's cache for `cms`, syncing with this suite's page size.
 *
 * Not `Wallet.awaitCommitments`, which runs the same loop but syncs with a
 * hardcoded `AWAIT_COMMITMENTS_SYNC_LIMIT = 200` and exposes no way to raise
 * it. Every test file shares one fmd index and each transaction writes several
 * leaves, so past 200 notes that sync stops reaching the newest page: the
 * commitment is on chain and in the index and the wait times out regardless.
 * The symptom is a test that passes in isolation and fails partway through a
 * full run, on a different test each time.
 */
async function pollForCommitments(
    w: Wallet,
    cms: string[],
    opts: PollOpts,
): Promise<{ missing: string[]; attempts: number }> {
    const target = cms.map((c) => c.toLowerCase());
    const missing = (): string[] => {
        const seen = new Set(w.notes().map((n) => n.cm.toLowerCase()));
        return target.filter((c) => !seen.has(c));
    };

    let attempts = 0;
    for (; attempts < opts.maxAttempts; attempts++) {
        if (missing().length === 0) break;
        await w.sync({ limit: SYNC_LIMIT });
        if (missing().length === 0) {
            attempts += 1;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
    }
    return { missing: missing(), attempts };
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
 * Advance the chain once a note has landed, then wait out the SDK's block
 * cache.
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
 * returns.
 *
 * Mining alone is not sufficient. The SDK builds its viem client as
 * `createPublicClient({ transport: http(rpcUrl) })` with no `cacheTime`, so
 * viem's default applies and `getBlockNumber` is served from cache for
 * `pollingInterval` (4s). The selector compares a note's block against that
 * cached tip, which with `--block-time=1` can trail the chain by several
 * blocks, so a note on chain for four blocks still reads as
 * `tip - firstSeenBlock < 1`. The staleness is in the reader, not the chain, so
 * the cache window has to be waited out. `rpcProvider` does the equivalent for
 * ethers (see `tx.ts`), but the SDK's client is not configurable from here.
 */
async function advanceOneBlock(): Promise<void> {
    try {
        await provider().send("anvil_mine", ["0x2"]);
    } catch {
        // not anvil; a real chain advances on its own
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, VIEM_BLOCK_CACHE_MS + 250));
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
 */
export async function assertMerkleConsistency(w: Wallet, cms: string[]): Promise<void> {
    const masp = maspReader();
    const notes = w.file.notes;
    // Every commitment in one tx folds into the same root, so each distinct
    // root is checked once rather than issuing an eth_call per output.
    const checked = new Set<string>();
    for (const cm of cms) {
        const stored = notes.find((n) => n.cm === cm);
        if (!stored) throw new Error(`assertMerkleConsistency: note not found for cm=${cm}`);
        const rootHex = cmToHex(w.treeStore.getPath(stored.leafIndex).root);
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
 * Poll `sync()` until the wallet sees a positive balance for `asset`.
 *
 * Used by the swap test: the relayer flushes the output-asset note
 * asynchronously, so its commitment is in no `r.commitments` returned to the
 * caller.
 */
export async function awaitBalance(
    w: Wallet,
    asset: bigint,
    opts: { timeoutMs?: number; pollMs?: number; syncLimit?: number } = {},
): Promise<bigint> {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT.BALANCE_POLL_MS;
    const pollMs = opts.pollMs ?? POLL.COMMITMENT.pollMs;
    const syncLimit = opts.syncLimit ?? SYNC_LIMIT;
    return pollUntil(
        async () => {
            await w.sync({ limit: syncLimit });
            const b = w.balance(assetId(asset));
            return b > 0n ? b : null;
        },
        { label: `balance(asset=${asset})`, timeoutMs, intervalMs: pollMs },
    );
}
