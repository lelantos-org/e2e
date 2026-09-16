// The relayer's side of a fee: not what the payer was charged, but what the
// relayer can actually spend.
//
// Every other fee assertion in the suite is written from the payer's view.
// `feePaid` reads a spend's fee off its result (`fees.relayer`), and a
// deposit's escrow carries its fee leaf (`escrow.cancelInputs`). Both say the
// value left the payer, and neither says where it went: a fee note built
// against the wrong address, carrying a clue the relayer's detection key does
// not flag, or a ciphertext its ivk cannot open, debits the payer identically
// and leaves the relayer holding nothing. That is the drift
// `tests/shielded-fee.test.ts` guards the constants against, and the same shape
// of bug in the wallet's note-building would pass every balance assertion in
// `tests/`.
//
// These close that gap by scanning as the relayer. `RELAYER_FEE_NSK` is the
// spending key behind the address wallets pay, so a wallet on it recovers the
// fee note through the same FMD detect + trial-decrypt the relayer runs, and a
// commitment it cannot recover is one the relayer cannot spend.
//
// Each helper returns the fee it verified, so it replaces the fee read a test
// would otherwise make rather than adding a second one:
//
//     const fee = await expectRelayerPaid(r, ASSET);
//     expect(await shieldedBalance(alice, ASSET)).toBe(DEPOSIT - TO_BOB - fee);

import { expect } from "vitest";

import type {
    AssetId,
    DepositResult,
    SwapResult,
    TransferResult,
    WalletApi,
    WalletNote,
    WithdrawResult,
} from "@lelantos-org/sdk";

import { RELAYER_FEE_NSK } from "../protocol/shielded-fee.js";
import { pollUntil } from "../utils.js";
import { createTestWallet, onWalletsDisposed } from "../wallet.js";
import { feePaid } from "./spend-fee.js";
import { POLL, SYNC_LIMIT, TIMEOUT } from "./timeouts.js";

let _wallet: Promise<WalletApi> | undefined;

// Module state outlives the per-file drain, so the handle has to be dropped
// with it or the next file scans through a disposed wallet.
onWalletsDisposed(() => {
    _wallet = undefined;
});

/**
 * A wallet on the identity the relayer is paid at, memoised per test file.
 *
 * Memoised because the first `sync()` trial-decrypts the whole shared index
 * while later ones are incremental: a fresh wallet per assertion would pay that
 * cost every time. It never spends — the suite only reads what it recovered —
 * but it is built from the nsk rather than the ivk, so the notes it reports are
 * ones a real relayer could spend and not merely ones it could read.
 */
export function relayerFeeWallet(): Promise<WalletApi> {
    return (_wallet ??= createTestWallet(RELAYER_FEE_NSK));
}

/**
 * Assert the relayer holds a note worth `charged` among `cms`, and return
 * `charged`.
 *
 * Zero fails: this stack's relayer charges for every deposit and spend, so a
 * zero charge is a fee path that built no note, and accepting it would pass
 * every balance assertion written in terms of the returned fee.
 */
async function expectSettled(
    charged: bigint,
    cms: readonly string[],
    asset: AssetId,
    label: string,
): Promise<bigint> {
    expect(charged, `${label}: the relayer charges for this path, so the fee is nonzero`).toBeGreaterThan(0n);
    const note = await awaitRelayerNote(cms, label);
    expect(note.value, `${label}: value`).toBe(charged);
    // A note in the wrong denomination is worth nothing to the relayer and
    // shows up in no balance assertion, since both are in circuit units.
    expect(note.asset, `${label}: asset`).toBe(asset);
    return charged;
}

/**
 * Wait until the relayer recovers exactly one of `cms`, and return it.
 *
 * Exactly one, not at least one: callers pass every commitment a transaction
 * produced, so a second hit means the relayer's keys opened a note that was not
 * addressed to it — a leak, and a louder failure than a wrong amount.
 */
async function awaitRelayerNote(cms: readonly string[], label: string): Promise<WalletNote> {
    const wanted = new Set(cms.map((c) => c.toLowerCase()));
    const w = await relayerFeeWallet();
    const hitsAfterSync = async (): Promise<WalletNote[]> => {
        await w.sync({ scope: "notes", pageSize: SYNC_LIMIT });
        return (await w.notes()).filter((n) => wanted.has(n.cm.toLowerCase()));
    };
    await pollUntil(
        async () => ((await hitsAfterSync()).length > 0 ? true : null),
        { label, timeoutMs: TIMEOUT.POLL_DEFAULT_MS, intervalMs: POLL.SPEND.pollMs },
    );
    // Counted after one more sync: the first poll to see a hit can predate the
    // indexer surfacing a second, leaked note from the same transaction.
    const found = await hitsAfterSync();
    if (found.length > 1) {
        throw new Error(
            `${label}: the relayer recovered ${found.length} of the ${cms.length} commitments ` +
                `(${found.map((n) => n.cm).join(", ")}) — only its own fee note should be ` +
                "readable with its keys",
        );
    }
    return found[0];
}

/**
 * Assert the relayer collected what `r` charged, and return that fee.
 *
 * Drop-in for `feePaid(r)`: same value, plus the fee note is confirmed to have
 * reached the relayer's own wallet.
 */
export async function expectRelayerPaid(
    r: TransferResult | WithdrawResult | SwapResult,
    asset: AssetId,
): Promise<bigint> {
    return expectSettled(
        feePaid(r),
        r.commitments,
        asset,
        `relayer fee note (${r.kind} ${r.txHash})`,
    );
}

/**
 * Assert the relayer collected what a deposit escrowed for it, and return that
 * fee.
 *
 * The fee leaf comes from the escrow rather than `r.commitments`, which carries
 * only the depositor's leaf, since counting the fee leaf would inflate the
 * wallet's balance with value it cannot spend. `escrow.cancelInputs` is the
 * `DepositEscrowed` payload, so it is what the payer was actually debited for.
 *
 * The leaf reaches the tree at flush, not at submit, so call this after the
 * `awaitOwn` that already waits on that flush.
 */
export async function expectRelayerPaidOnDeposit(r: DepositResult, asset: AssetId): Promise<bigint> {
    const { feeIn, feeAssetId, feeCm } = r.escrow.cancelInputs;
    const label = `relayer fee note (deposit ${r.txHash})`;
    // The escrow names the fee asset the pool pulled and the flush binds the
    // leaf to, so a mismatch here is caught before the note is looked for.
    expect(feeAssetId, `${label}: feeAssetId`).toBe(asset);
    return expectSettled(feeIn, [feeCm], asset, label);
}

/**
 * Assert the relayer collected `charged` on a named fee commitment, and return
 * it.
 *
 * For the direct `buildDeposit` path, which produces no SDK result and holds
 * `deposit.feeCm` itself. `charged` is passed rather than derived because there
 * is no result or event the caller has not already read.
 */
export async function expectRelayerPaidOnCommitment(
    feeCm: string | readonly string[],
    charged: bigint,
    asset: AssetId,
    label?: string,
): Promise<bigint> {
    // A list is for a caller that knows what was charged but not which leaf
    // carries it — a spend whose result never reached the client, for
    // instance. `expectSettled` still requires exactly one of them to be the
    // relayer's, so passing every commitment does not weaken the check.
    const cms = typeof feeCm === "string" ? [feeCm] : feeCm;
    if (cms.length === 0) throw new Error("expectRelayerPaidOnCommitment: no commitments given");
    return expectSettled(charged, cms, asset, label ?? `relayer fee note (${cms[0].slice(0, 12)}…)`);
}
