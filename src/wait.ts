// Test waits that read off a `TransactionResult`. Pick the right poll
// shape from the tx kind and route the right commitments to the right
// wallet so each call site stays one line.

import { FmdClient, type TransactionResult, type Wallet } from "@lelantos-org/sdk";

import { POLL, type PollOpts } from "./constants.js";
import { recipientCommitments } from "./scenario.js";
import { pollUntil } from "./utils.js";

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

export async function assertMerkleConsistency(
    w: Wallet,
    cms: string[],
): Promise<void> {
    if (!w.cfg.fmdUrl) return;
    const fmd = new FmdClient(w.cfg.fmdUrl, w.cfg.chainId);
    const notes = w.file.notes;
    for (const cm of cms) {
        const stored = notes.find((n) => n.cm === cm);
        if (!stored) throw new Error(`assertMerkleConsistency: note not found for cm=${cm}`);
        const local = w.treeStore.getPath(stored.leafIndex);
        const remote = await fmd.fetchPath(cm);
        if (local.root !== remote.root)
            throw new Error(`Merkle root mismatch for cm=${cm}: local=${local.root} remote=${remote.root}`);
        for (let i = 0; i < local.pathIndices.length; i++) {
            if (local.pathIndices[i] !== remote.pathIndices[i])
                throw new Error(`pathIndices[${i}] mismatch for cm=${cm}`);
        }
        for (let i = 0; i < local.pathElements.length; i++) {
            for (let j = 0; j < local.pathElements[i].length; j++) {
                if (local.pathElements[i][j] !== remote.pathElements[i][j])
                    throw new Error(`pathElements[${i}][${j}] mismatch for cm=${cm}`);
            }
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
    const timeoutMs = opts.timeoutMs ?? 150_000;
    const pollMs = opts.pollMs ?? 2000;
    const syncLimit = opts.syncLimit ?? 200;
    return pollUntil(
        async () => {
            await w.sync({ limit: syncLimit });
            const b = w.balance(asset);
            return b > 0n ? b : null;
        },
        { label: `balance(asset=${asset})`, timeoutMs, intervalMs: pollMs },
    );
}
