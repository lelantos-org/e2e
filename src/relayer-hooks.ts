// Client for the relayer's bundler test hooks.
//
// The relayer batches naturally: an idle batcher sends a lone operation at once
// and bundles only what queued behind a transaction in flight. Which operations
// share a transaction is then a race between the client's proving and the
// chain's blocks, so a test cannot build a particular bundle by timing its
// submits. The hooks remove the race. `hold` stops the batcher from dispatching,
// the test queues exactly the operations it wants and watches them arrive with
// `queue`, and `release` sends them as the next bundle.
//
// Mounted only with `[test_hooks] enabled = true` (`config/relayer.toml`).
// Routes: `backend/crates/relayer/src/handlers/http/test_hooks.rs`.
//
// A hold is chain-wide and outlives the test that set it: every later
// submission on the chain, from any file, waits behind it. A test that holds
// must release in a `finally`.

import { TIMEOUT } from "./testkit/timeouts.js";
import { pollUntil } from "./utils.js";

/**
 * One operation waiting in the batcher, as the relayer reports it.
 *
 * `kind` is the relayer's `EntryPoint::as_str`: `transfer`, `withdraw`,
 * `withdrawNative`, `swap` or `flush`.
 */
export interface QueuedOp {
    kind: "transfer" | "withdraw" | "withdrawNative" | "swap" | "flush";
    /** A spend's nullifiers, lowercase 0x-hex; empty for a flush. */
    nullifiers: string[];
    /** A flush's deposit ids; empty for a spend. */
    depositIds: number[];
}

export class RelayerHooks {
    constructor(
        private readonly relayerUrl: string,
        private readonly chainId: bigint,
    ) {}

    /** Stop dispatching. Operations submitted from here on queue until `release`. */
    async hold(): Promise<void> {
        await this.post("hold");
    }

    /**
     * Dispatch the queue as normal, then resume. Safe when nothing is held, so
     * cleanup can call it unconditionally.
     */
    async release(): Promise<void> {
        await this.post("release");
    }

    /**
     * What is queued behind the hold, oldest first.
     *
     * Published by the batcher only while it waits on a hold, so outside one
     * this is whatever it last saw rather than a live view.
     */
    async queue(): Promise<QueuedOp[]> {
        const res = await fetch(this.url("queue"), { signal: AbortSignal.timeout(TIMEOUT.HTTP_MS) });
        if (!res.ok) throw new Error(`GET ${this.url("queue")}: ${res.status} ${await res.text()}`);
        const ops = (await res.json()) as QueuedOp[];
        return ops.map((op) => ({ ...op, nullifiers: op.nullifiers.map((n) => n.toLowerCase()) }));
    }

    /**
     * Poll the queue until `predicate` accepts it, and return that queue.
     *
     * The failure names the last queue seen, which separates "the operation
     * never reached the relayer" from "it arrived as something else".
     */
    async waitQueued(
        predicate: (ops: QueuedOp[]) => boolean,
        timeoutMs: number = TIMEOUT.POLL_DEFAULT_MS,
        label = "relayer queue",
    ): Promise<QueuedOp[]> {
        let last: QueuedOp[] = [];
        try {
            return await pollUntil(
                async () => {
                    last = await this.queue();
                    return predicate(last) ? last : null;
                },
                { label, timeoutMs, intervalMs: 250 },
            );
        } catch (e) {
            throw new Error(`${label}: last queue ${JSON.stringify(last)}`, { cause: e });
        }
    }

    private url(hook: "hold" | "queue" | "release"): string {
        return `${this.relayerUrl}/test/bundler/${this.chainId}/${hook}`;
    }

    private async post(hook: "hold" | "release"): Promise<void> {
        const res = await fetch(this.url(hook), {
            method: "POST",
            signal: AbortSignal.timeout(TIMEOUT.HTTP_MS),
        });
        if (res.status !== 204) {
            throw new Error(`POST ${this.url(hook)}: ${res.status} ${await res.text()}`);
        }
    }
}
