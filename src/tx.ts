// Nonce plumbing for the payer account.
//
// The payer key is driven by two independent stacks: `h.payer` (ethers, for
// direct contract calls) and the SDK's viem `PrivateKeySigner` (deposit /
// transact / swap). Neither may cache nonces locally — they would diverge from
// each other — so both ask anvil for the account's `pending` count on every
// send. Two sends whose windows overlap therefore read the same value, and the
// loser comes back `NONCE_EXPIRED` ("nonce too low"), which is the CI flake
// this file exists to remove.
//
// Three things close the window:
//   * `providerOpts` — ethers memoises a `_perform` result for 250ms, which
//     covers `eth_getTransactionCount`. Two sends inside that window get the
//     *same cached* nonce even when the first has already been mined.
//   * `SerialWallet` — queues the ethers-side sends so they never overlap
//     each other.
//   * the retry inside it — covers the half it cannot see, an SDK send landing
//     between our nonce read and our submit, by re-populating and resending.

import { ethers } from "ethers";

import { pollUntil } from "./utils.js";

const NONCE_RETRIES = 6;
const RETRY_DELAY_MS = 200;

/**
 * Provider options every ethers provider in the suite is built with.
 *
 * `cacheTimeout: -1` disables the 250ms `_perform` cache. On a 1s-block anvil
 * shared by 12 files, a stale `getTransactionCount` is a wrong nonce, not a
 * saved round-trip.
 */
export const providerOpts: ethers.JsonRpcApiProviderOptions = { cacheTimeout: -1 };

export function rpcProvider(url: string): ethers.JsonRpcProvider {
    return new ethers.JsonRpcProvider(url, undefined, providerOpts);
}

function isNonceError(e: unknown): boolean {
    const err = e as { code?: unknown; message?: unknown; shortMessage?: unknown; info?: unknown };
    if (err?.code === "NONCE_EXPIRED" || err?.code === "REPLACEMENT_UNDERPRICED") return true;
    const text = [err?.message, err?.shortMessage, JSON.stringify(err?.info ?? "")]
        .filter((v) => typeof v === "string")
        .join(" ");
    return /nonce (too low|has already been used)|replacement transaction underpriced/i.test(text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One queue per process: every `SerialWallet` shares the payer account, so
// serialising per instance would not help.
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
}

/**
 * An `ethers.Wallet` whose sends are serialised process-wide and retried on a
 * lost nonce race.
 *
 * A caller that sets `nonce` explicitly (`ethers.NonceManager`, which
 * `batch-flush` uses to fan out N deposits) opts out of the retry: resending
 * with a fresh nonce would silently reorder its batch. It still goes through
 * the queue, which only orders the submits.
 */
export class SerialWallet extends ethers.Wallet {
    override async sendTransaction(
        tx: ethers.TransactionRequest,
    ): Promise<ethers.TransactionResponse> {
        const managed = tx.nonce == null;
        return serialize(async () => {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await super.sendTransaction({ ...tx });
                } catch (e) {
                    if (!managed || attempt >= NONCE_RETRIES || !isNonceError(e)) throw e;
                    await sleep(RETRY_DELAY_MS);
                }
            }
        });
    }
}

/**
 * Block until the account has nothing in flight.
 *
 * Called once per file: a tx left in the pool by the previous file is a nonce
 * the next `pending` read has to account for, and anvil's pending view lags
 * the pool briefly after a block. Equal `pending` and `latest` counts means
 * the pool is drained for this account and the next send can trust its read.
 */
export async function settleNonce(
    provider: ethers.JsonRpcProvider,
    address: string,
): Promise<number> {
    // Boxed: `pollUntil` retries on any falsy value, and nonce 0 is a real
    // answer on a fresh chain.
    const { nonce } = await pollUntil(async () => {
        const [pending, latest] = await Promise.all([
            provider.getTransactionCount(address, "pending"),
            provider.getTransactionCount(address, "latest"),
        ]);
        return pending === latest ? { nonce: pending } : null;
    }, { label: `nonce settle(${address.slice(0, 10)})`, timeoutMs: 30_000, intervalMs: 250 });
    return nonce;
}
