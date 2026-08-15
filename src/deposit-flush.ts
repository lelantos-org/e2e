// Event-driven view of the relayer's deposit settlement, via the SDK's
// `DepositStream`.
//
// A deposit is escrowed on broadcast and only enters the tree when the
// relayer's flush tick drains it (`flush_interval_s` in config/relayer.toml).
// Polling the note cache conflates "the relayer has not flushed yet" with
// "it flushed but the indexer has not caught up"; the flush event separates
// them, so a hang points at one service instead of two.

import { DepositStream, type FlushWait } from "@lelantos-org/sdk/relayer";

import { TIMEOUT } from "./constants.js";
import { env } from "./env.js";
import { nodeEventSource } from "./sse.js";

export interface FlushWatch {
    /// Settles when the flush is seen, the timeout expires, or the feed dies.
    settled: Promise<FlushWait>;
    /// The outcome as one line, for a failure message.
    explain(): Promise<string>;
    /// Drop the stream. Safe once the caller no longer needs the outcome;
    /// `settled` still resolves (as `"closed"`).
    close(): void;
}

/**
 * Start watching for `depositId`'s flush, without waiting for it.
 *
 * Purely advisory, so it must never sit on the critical path: the stream only
 * opens once the deposit is already broadcast, and a flush landing in that gap
 * is simply missed. Callers run this alongside the note-cache poll — which
 * stays the source of truth — and read the outcome only to explain a failure.
 */
export function watchDepositFlush(
    depositId: bigint,
    timeoutMs: number = TIMEOUT.DEPOSIT_FLUSH_MS,
): FlushWatch {
    const stream = new DepositStream(env.relayerUrl, env.chainId, {
        eventSourceFactory: nodeEventSource,
    });
    const settled = stream.awaitFlush(depositId, { signal: AbortSignal.timeout(timeoutMs) });
    return {
        settled,
        // Formats against the timeout actually used, so a caller-supplied one
        // cannot drift from the message.
        explain: async () => describe(await settled, timeoutMs),
        close: () => stream.close(),
    };
}

function describe(wait: FlushWait, timeoutMs: number): string {
    switch (wait.kind) {
        case "flushed":
            return `relayer flushed it in ${wait.txHash} at block ${wait.blockNumber}`;
        case "aborted":
            return `relayer did not flush it within ${timeoutMs}ms`;
        case "closed":
            return "relayer deposit stream was unavailable";
    }
}
