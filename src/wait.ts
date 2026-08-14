// Test waits that read off a `TransactionResult`. Pick the right poll
// shape from the tx kind and route the right commitments to the right
// wallet so each call site stays one line.

import { ethers } from "ethers";

import { assetId, type TransactionResult, type Wallet } from "@lelantos-org/sdk";

import { MASP_ABI, POLL, type PollOpts, SYNC_LIMIT, TIMEOUT } from "./constants.js";
import { env } from "./env.js";
import { recipientCommitments } from "./scenario.js";
import { cmToHex, pollUntil } from "./utils.js";

/// `deposit` waits on the shielding flush window (slowest); spends are
/// faster because the relayer's spend pipeline is event-driven.
function pollForKind(kind: TransactionResult["kind"]): PollOpts {
    return kind === "deposit" ? POLL.COMMITMENT : POLL.SPEND;
}

/// Wait for the tx's own (non-zero) outputs to land in the sender's cache,
/// then sync the local Merkle tree so spend operations have a valid root.
export async function awaitOwn(
    w: Wallet,
    r: TransactionResult,
    opts: PollOpts = pollForKind(r.kind),
): Promise<void> {
    await w.awaitCommitments(r.ownCommitments, opts);
    await w.treeStore.sync();
    await assertMerkleConsistency(w, r.ownCommitments);
}

/// Wait for the tx's recipient-side commitments — the non-own subset of
/// non-zero outputs. Use on the counterparty wallet (`bob` in a transfer).
export async function awaitRecipient(
    w: Wallet,
    r: TransactionResult,
    opts: PollOpts = pollForKind(r.kind),
): Promise<void> {
    await w.awaitCommitments(recipientCommitments(r), opts);
    await w.treeStore.sync();
    await assertMerkleConsistency(w, recipientCommitments(r));
}

let _masp: ethers.Contract | undefined;

function maspReader(): ethers.Contract {
    _masp ??= new ethers.Contract(
        env.maspAddress,
        MASP_ABI,
        new ethers.JsonRpcProvider(env.rpcUrl),
    );
    return _masp;
}

/// Cross-check the wallet's locally folded Merkle tree against the chain.
///
/// The wallet never asks anyone for a path: it pages the commitment chunk
/// feed and folds the tree itself, so a fold bug (wrong leaf hash, wrong
/// ordering, a missed chunk) would surface only when the pool rejected the
/// spend proof several steps later, with `UnknownRoot` and no hint as to
/// which note was wrong. This pins it at the point of insertion.
///
/// The pool is the source of truth, and `isKnownRoot` is the exact predicate
/// a spend is checked against — it accepts any root in the ring, so a wallet
/// trailing the tip by a few advances still passes, which is normal while the
/// indexer catches up.
///
/// Deliberately not a by-commitment lookup against the relayer: asking a
/// server for the path to a specific cm tells it which note is about to be
/// spent, which is the pattern the chunk feed exists to avoid. The SDK
/// dropped its `path(cm)` client for that reason.
export async function assertMerkleConsistency(w: Wallet, cms: string[]): Promise<void> {
    const masp = maspReader();
    const notes = w.file.notes;
    // Every commitment in one tx folds into the same root; check each
    // distinct one once rather than issuing an eth_call per output.
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

/// Poll `sync()` until the wallet sees a positive balance for `asset`.
/// Used by the swap test (relayer flushes the B-note asynchronously, so
/// the assetOut cm is not in any `r.commitments` returned to the caller).
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
