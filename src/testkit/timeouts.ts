// Every waiting budget in the suite, in one place so a slow CI run is retuned
// by editing one file.
//
// Three kinds, and they are not interchangeable:
//   * `TIMEOUT`      — how long an internal `pollUntil` waits before failing
//   * `TEST_TIMEOUT` — vitest's per-`it` budget, passed as the timeout argument
//   * `POLL`         — attempt/interval pairs for the SDK's `awaitCommitments`
//
// A `TEST_TIMEOUT` must always exceed the `TIMEOUT` of whatever the test waits
// on, or the poll's diagnostic message is never printed: vitest kills the test
// first and reports its own generic timeout instead.

export const TIMEOUT = {
    POLL_DEFAULT_MS: 120_000,
    BATCH_FLUSH_MS: 150_000,
    BALANCE_POLL_MS: 150_000,
    /**
     * How long to watch for a deposit's flush event. Several relayer ticks
     * (`flush_interval_s`), so a deposit that just missed one is covered.
     * Advisory only — the note-cache poll is what decides pass or fail.
     */
    DEPOSIT_FLUSH_MS: 60_000,
} as const;

/**
 * Per-`it` budgets, passed as vitest's timeout argument. Named by what the
 * test actually waits on, so a slow CI run is retuned in one place.
 */
export const TEST_TIMEOUT = {
    /** One spend: proof + chain inclusion + indexer pickup. */
    SPEND: 240_000,
    /** A swap — as above plus the relayer-flushed second leg. */
    SWAP: 360_000,
    /** A multi-transaction narrative inside a single `it`. */
    SEQUENCE: 600_000,
    /** Reads settled state only; no chain round trip. */
    LOCAL: 60_000,
    /** N parallel deposits plus a relayer flush tick. */
    BATCH_FLUSH: 240_000,
} as const;

// fmd-webserver caps `listNotes` at 1000 rows; ask for the max.
export const LIST_LIMIT = 1000;

// Page size for a wallet's scan. Test files share one fmd index, so this is a
// silent correctness cliff: once the index holds more rows than this, a freshly
// written note is buried behind older pages and a `sync()` that "found nothing"
// is really "looked at the wrong page".
//
// Pinned to the server's own cap rather than a smaller number. Shielded fees
// roughly doubled the leaves each transaction writes — a deposit mints two
// (the depositor's note and the relayer's), and a fee-paying spend fills every
// output slot instead of padding with zeros — so a limit that used to hold for
// a whole run started burying notes partway through it. That surfaced as
// `awaitOwn` timing out on a commitment that was on chain and in the index the
// whole time, and only in full-suite runs, never in isolation.
export const SYNC_LIMIT = LIST_LIMIT;

export interface PollOpts {
    maxAttempts: number;
    pollMs: number;
}

/**
 * Picked by `awaitOwn`/`awaitRecipient` based on the tx kind. Override
 * per-call by passing a `PollOpts` to either helper. `COMMITMENT` covers
 * the relayer flush window (slow); `SPEND` is the spend pipeline path.
 */
export const POLL: Record<"COMMITMENT" | "SPEND", PollOpts> = {
    COMMITMENT: { maxAttempts: 80, pollMs: 2000 },
    SPEND:      { maxAttempts: 60, pollMs: 1500 },
} as const;

/**
 * viem's default `getBlockNumber` cache window, in ms.
 *
 * `cacheTime` defaults to `pollingInterval` (4000ms) and the SDK's client sets
 * neither, so a tip read can be this stale. `advanceOneBlock` waits it out —
 * see the note there for why mining more blocks does not help.
 */
export const VIEM_BLOCK_CACHE_MS = 4_000;
