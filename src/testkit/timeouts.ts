// Every waiting budget in the suite, in one place, so a slow CI run is retuned
// by editing one file.
//
// Three kinds, not interchangeable:
//   * `TIMEOUT`      — how long an internal `pollUntil` waits before failing
//   * `TEST_TIMEOUT` — vitest's per-`it` budget, passed as its timeout argument
//   * `POLL`         — attempt/interval pairs for the commitment waits
//
// A `TEST_TIMEOUT` must exceed the `TIMEOUT` of whatever the test waits on, or
// the poll's diagnostic is never printed: vitest kills the test first and
// reports its own generic timeout instead.

export const TIMEOUT = {
    POLL_DEFAULT_MS: 120_000,
    BATCH_FLUSH_MS: 150_000,
    BALANCE_POLL_MS: 150_000,
    /**
     * How long to watch for a deposit's flush event. Spans several relayer
     * ticks (`flush_interval_s`), covering a deposit that narrowly missed one.
     * Advisory only; the note-cache poll decides pass or fail.
     */
    DEPOSIT_FLUSH_MS: 60_000,
} as const;

/** Per-`it` budgets, named by what the test waits on. */
export const TEST_TIMEOUT = {
    /** One spend: proof + chain inclusion + indexer pickup. */
    SPEND: 240_000,
    /** A swap: as above, plus the relayer-flushed second leg. */
    SWAP: 360_000,
    /** A multi-transaction narrative inside a single `it`. */
    SEQUENCE: 600_000,
    /** Reads settled state only; no chain round trip. */
    LOCAL: 60_000,
    /** N parallel deposits plus a relayer flush tick. */
    BATCH_FLUSH: 240_000,
} as const;

// fmd-webserver caps `listNotes` at 1000 rows; ask for the maximum.
export const LIST_LIMIT = 1000;

/**
 * Page size for a wallet's scan.
 *
 * Test files share one fmd index, so this is a silent correctness cliff: once
 * the index holds more rows than this, a freshly written note sits behind older
 * pages and a `sync()` that "found nothing" has looked at the wrong page. That
 * surfaces as `awaitOwn` timing out on a commitment that is on chain and in the
 * index, and only in full-suite runs.
 *
 * Pinned to the server's own cap because each transaction writes several
 * leaves: a deposit mints two, and a fee-paying spend fills every output slot
 * rather than padding with zeros.
 */
export const SYNC_LIMIT = LIST_LIMIT;

export interface PollOpts {
    maxAttempts: number;
    pollMs: number;
}

/**
 * Picked by `awaitOwn`/`awaitRecipient` from the tx kind, and overridable
 * per call. `COMMITMENT` covers the relayer flush window; `SPEND` covers the
 * spend pipeline.
 */
export const POLL: Record<"COMMITMENT" | "SPEND", PollOpts> = {
    COMMITMENT: { maxAttempts: 80, pollMs: 2000 },
    SPEND:      { maxAttempts: 60, pollMs: 1500 },
} as const;

/**
 * viem's default `getBlockNumber` cache window, in ms.
 *
 * `cacheTime` defaults to `pollingInterval` (4000ms) and the SDK's client sets
 * neither, so a tip read can be this stale. `advanceOneBlock` waits it out; see
 * the note there for why mining more blocks does not help.
 */
export const VIEM_BLOCK_CACHE_MS = 4_000;
