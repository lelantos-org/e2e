// The relayer's side of a fee: not what the payer was charged, but what the
// relayer can actually spend.
//
// Every other fee assertion in the suite is written from the payer's view.
// `feePaid` derives a spend's fee from the conservation the circuit enforces,
// and `depositFeeLeaf` reads a deposit's off its own escrow event. Both say the
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
// Each helper returns the fee it verified, so it replaces the `feePaid` /
// `depositFeeLeaf` read a test already makes rather than adding a second one:
//
//     const fee = await expectRelayerPaid(r, ASSET);
//     expect(alice.balance(ASSET)).toBe(DEPOSIT - TO_BOB - fee);

import { expect } from "vitest";

import type {
    AssetId,
    SwapResult,
    TransferResult,
    Wallet,
    WalletNote,
    WithdrawResult,
} from "@lelantos-org/sdk";
import type { ethers } from "ethers";

import { RELAYER_FEE_NSK } from "../protocol/shielded-fee.js";
import { env } from "../env.js";
import { pollUntil } from "../utils.js";
import { createTestWallet, onWalletsDisposed } from "../wallet.js";
import { depositFeeLeaf } from "./deposit-fee.js";
import { feePaid } from "./spend-fee.js";
import { POLL, SYNC_LIMIT, TIMEOUT } from "./timeouts.js";

let _wallet: Promise<Wallet> | undefined;

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
export function relayerFeeWallet(): Promise<Wallet> {
    return (_wallet ??= createTestWallet(RELAYER_FEE_NSK));
}

/**
 * Assert the relayer holds a note worth `charged` among `cms`, and return
 * `charged`.
 *
 * Zero short-circuits: a chain that subsidises the path builds no fee note, so
 * there is none to find and waiting for one would burn the whole poll budget.
 * Callers can therefore use these helpers unconditionally.
 */
async function expectSettled(
    charged: bigint,
    cms: readonly string[],
    asset: AssetId,
    label: string,
): Promise<bigint> {
    if (charged === 0n) return 0n;
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
    const found = await pollUntil(
        async () => {
            await w.sync({ limit: SYNC_LIMIT });
            const hits = w.notes().filter((n) => wanted.has(n.cm.toLowerCase()));
            return hits.length > 0 ? hits : null;
        },
        { label, timeoutMs: TIMEOUT.POLL_DEFAULT_MS, intervalMs: POLL.SPEND.pollMs },
    );
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
 * fee. Supersedes reading `depositFeeLeaf(...).value` directly.
 *
 * The commitment comes from the escrow event rather than the result:
 * `DepositResult.commitments` carries only the depositor's leaf, since counting
 * the fee leaf would inflate the wallet's balance with value it cannot spend.
 *
 * The leaf reaches the tree at flush, not at submit, so call this after the
 * `awaitOwn` that already waits on that flush.
 */
export async function expectRelayerPaidOnDeposit(
    provider: ethers.Provider,
    txHash: string,
    asset: AssetId,
): Promise<bigint> {
    const leaf = await depositFeeLeaf(provider, env.maspAddress, txHash);
    return expectSettled(leaf.value, [leaf.cm], asset, `relayer fee note (deposit ${txHash})`);
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
    feeCm: string,
    charged: bigint,
    asset: AssetId,
    label = `relayer fee note (${feeCm.slice(0, 12)}…)`,
): Promise<bigint> {
    return expectSettled(charged, [feeCm], asset, label);
}
