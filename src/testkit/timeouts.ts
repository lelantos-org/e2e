// Every waiting budget in the suite, in one place, so a slow CI run is retuned
// by editing one file.
//
// Three kinds, not interchangeable:
//   * `TIMEOUT`      — how long an internal `pollUntil` waits before failing
//   * `POLL`         — wall-clock budget and interval for the commitment waits
//   * `TEST_TIMEOUT` — vitest's per-`it` budget, passed as its timeout argument
//
// A `TEST_TIMEOUT` must exceed the sum of the waits its test can run, or the
// poll's diagnostic is never printed: vitest kills the test first and reports
// its own generic timeout instead. So the per-test budgets are derived from the
// waits below rather than written as independent numbers.

export const TIMEOUT = {
    POLL_DEFAULT_MS: 120_000,
    BATCH_FLUSH_MS: 150_000,
    /**
     * A swap's output note lands on the next relayer flush tick; the relayer
     * quarantines a deposit after five failed ticks, so waiting past a minute
     * only delays the failure.
     */
    BALANCE_POLL_MS: 60_000,
    /**
     * How long to watch for a deposit's flush event. Spans several relayer
     * ticks (`flush_interval_s`), covering a deposit that narrowly missed one.
     * Advisory only; the note-cache poll decides pass or fail.
     */
    DEPOSIT_FLUSH_MS: 60_000,
    /**
     * One plain HTTP request to a stack service (health, test hooks, explorer).
     * Without a deadline a service that accepts and never answers holds the
     * test until vitest kills it.
     */
    HTTP_MS: 15_000,
} as const;

/** fmd-webserver caps `listNotes` at 1000 rows; ask for the maximum. */
export const LIST_LIMIT = 1000;

/**
 * Page size for a wallet's scan. The SDK pages through the whole feed with a
 * cursor, so this bounds each request, not what a sync can reach; the
 * server's own cap keeps a catch-up over the shared index to few requests.
 */
export const SYNC_LIMIT = LIST_LIMIT;

export interface PollOpts {
    /** Wall-clock budget for the whole wait, sync time included. */
    timeoutMs: number;
    /** Delay between syncs. */
    pollMs: number;
}

/**
 * Picked by `awaitOwn`/`awaitRecipient` from the tx kind, and overridable
 * per call. `COMMITMENT` covers the relayer flush window; `SPEND` covers the
 * spend pipeline.
 */
export const POLL: Record<"COMMITMENT" | "SPEND", PollOpts> = {
    COMMITMENT: { timeoutMs: 180_000, pollMs: 2000 },
    SPEND:      { timeoutMs: 120_000, pollMs: 1500 },
} as const;

/** Headroom on top of the waits for proving, receipts and plain reads. */
const SLACK_MS = 60_000;

/** A deposit: the note lands, then the relayer's fee note is recovered. */
const DEPOSIT_MS = POLL.COMMITMENT.timeoutMs + TIMEOUT.POLL_DEFAULT_MS + SLACK_MS;

/** A spend: both sides' notes land, then the relayer's fee note is recovered. */
const SPEND_MS = 2 * POLL.SPEND.timeoutMs + TIMEOUT.POLL_DEFAULT_MS + SLACK_MS;

/** Per-`it` budgets, named by what the test waits on. */
export const TEST_TIMEOUT = {
    /** One deposit, awaited and its relayer fee confirmed. */
    DEPOSIT: DEPOSIT_MS,
    /** One spend: proof + chain inclusion + indexer pickup on both sides. */
    SPEND: SPEND_MS,
    /** A swap: as above, plus the relayer-flushed second leg. */
    SWAP: SPEND_MS + TIMEOUT.BALANCE_POLL_MS,
    /**
     * A multi-transaction narrative, or an `it` that pulls in `once` steps
     * before its own: a deposit and a spend, then what the test itself waits on.
     */
    SEQUENCE: DEPOSIT_MS + 2 * SPEND_MS,
    /** Reads settled state only; no chain round trip. */
    LOCAL: 60_000,
    /**
     * Several deposits in a row, then a spend over them: the consolidation and
     * max-spend specs, where each deposit waits on its own flush.
     */
    MANY_DEPOSITS: 4 * DEPOSIT_MS,
    /** N parallel deposits, one flush, then every note and fee note in parallel. */
    BATCH_FLUSH: TIMEOUT.BATCH_FLUSH_MS + 2 * TIMEOUT.POLL_DEFAULT_MS + SLACK_MS,
} as const;
