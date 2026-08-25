// What a rejection looks like, and how to read one.
//
// `REVERT` names the guards the negative tests assert on; `errorText` is what
// those regexes are matched against. They live together because they only work
// as a pair: several entries below match on a contract error *name* that never
// appears in any message until `KNOWN_SELECTORS` decodes it out of raw revert
// data. Splitting them once meant the table documented a helper two modules
// away, and a selector added here without a matching entry there fails open —
// the regex simply never matches.

import { ethers } from "ethers";

/**
 * Rejection reasons, matched by `expectRevert`.
 *
 * Each entry names the specific guard its test is about. Where more than one
 * alternative is listed they are all *named states of that same guard* (the
 * relayer's pre-check versus the pool's on-chain check, say) — never a
 * catch-all like `/reverted/i`, which would let a misconfigured harness pass
 * a negative test without exercising anything.
 *
 * Contract error names come from `vendor/contracts`; relayer messages from
 * `AppError` in `vendor/backend/crates/relayer/src/domain/error.rs`. Selectors
 * are decoded by `KNOWN_SELECTORS` below for the cases where ethers
 * surfaces raw `data` from a sub-call.
 *
 * Note there is no entry for the swap wrapper's guards: the relayer collapses
 * every submit-time swap revert to an opaque `HTTP 500: internal error`, so
 * `AdapterNotAllowed` and the router's under-delivery revert never reach a
 * client. `tests/swap.test.ts` asserts on effects instead, and says so.
 */
export const REVERT = {
    /**
     * A spend of an already-published nullifier. Two layers can catch it and
     * which one does is a timing detail, so both named states are accepted:
     * the relayer rejects with `AppError::NullifierAlreadySpent` (HTTP 409,
     * `crates/relayer/src/domain/error.rs`) as soon as it has seen the first
     * spend, and only a request that gets past it reaches the pool's
     * `NullifierSet.DoubleSpend()`. In practice the relayer wins.
     */
    NULLIFIER_SPENT: /nullifier already spent|DoubleSpend/,
    /**
     * The loser of a race between two spends of one note. Same guard as
     * above, but the winner has not been indexed yet, so the relayer reports
     * the nullifier as in flight rather than spent. Both outcomes are correct
     * and which one appears depends on how far the loser got.
     */
    NULLIFIER_CONTESTED: /nullifier in flight|nullifier already spent|DoubleSpend/,
    /**
     * Permit2 `InvalidAmount(uint256)` — requestedAmount exceeds the signed
     * `permitted.amount` (our `sig.maxTotal`).
     */
    PERMIT2_INVALID_AMOUNT: /InvalidAmount/,
    /** Permit2 `SignatureExpired(uint256)`. */
    PERMIT2_EXPIRED: /SignatureExpired/,
    /**
     * `SwapWrapper.AdapterNotAllowed()` — adapter is not on the allowlist.
     * Reaches the client as the relayer's `ContractRejected` (HTTP 400),
     * which echoes the contract's revert data; the selector is decoded by
     * `KNOWN_SELECTORS` below.
     */
    ADAPTER_NOT_ALLOWED: /AdapterNotAllowed/,
    /**
     * The *router* rejects first: `UniV3Adapter` forwards `minOut` as
     * `amountOutMinimum`, so `MockSwapRouter02`'s require trips before
     * `SwapWrapper.InsufficientOut` is ever reached. Matching the wrapper's
     * error here would silently never fire.
     */
    SWAP_UNDER_MIN_OUT: /too little received/,
} as const;

// Revert selectors → readable names, so expectRevert regexes can match on the
// error name when ethers v6 surfaces the raw `data` from a sub-call (e.g.
// Permit2's `SignatureExpired`) without decoding it.
//
// Derived from the signatures rather than hand-written hex: a hand-typed
// selector that is subtly wrong fails open — the regex simply never matches
// and the test reports "did not match" instead of the real reason.
const KNOWN_ERROR_SIGNATURES = [
    // Permit2 (ISignatureTransfer / IAllowanceTransfer)
    "SignatureExpired(uint256)",
    "InvalidAmount(uint256)",
    "InvalidNonce()",
    // MASP
    "MustHaveDeposit()",
    "AmountOverflowsAllowance()",
    "UnknownRoot()",
    // NullifierSet
    "DoubleSpend()",
    "DuplicateNullifier()",
    // SwapWrapper
    "AdapterNotAllowed()",
    "InsufficientOut(uint256,uint256)",
    "MaspPullBelowMinOut(uint256,uint256)",
] as const;

const KNOWN_SELECTORS: Record<string, string> = Object.fromEntries(
    KNOWN_ERROR_SIGNATURES.map((sig) => [ethers.id(sig).slice(0, 10).toLowerCase(), sig]),
);

/**
 * Every scrap of text an error carries: its own message, ethers' `reason` /
 * `shortMessage`, an HTTP `body`, raw revert `data` (with known selectors
 * decoded), and the same again down the `cause` chain.
 *
 * Assertions match against this rather than `err.message`, because where a
 * reason lands moves between library versions — the SDK's `NetworkError` has
 * carried the server's response text in both places across releases.
 */
export function errorText(e: Error): string {
    const parts: string[] = [];
    let cur: Error | undefined = e;
    while (cur && parts.length < 8) {
        const c = cur as Error & {
            reason?: string;
            shortMessage?: string;
            data?: unknown;
            body?: unknown;
            cause?: unknown;
        };
        // `body` is the server's response text. The SDK's `NetworkError` used
        // to fold it into the message and now keeps it as its own field, so a
        // relayer's "nullifier already spent" is only reachable here — reading
        // both means an assertion does not care which the SDK is doing.
        for (const v of [c.message, c.reason, c.shortMessage, c.body]) {
            if (typeof v === "string") parts.push(v);
        }
        if (typeof c.data === "string") {
            parts.push(c.data);
            const sel = c.data.slice(0, 10).toLowerCase();
            const name = KNOWN_SELECTORS[sel];
            if (name) parts.push(name);
        }
        cur = c.cause instanceof Error ? c.cause : undefined;
    }
    // Also probe top-level message for embedded selectors (ethers v6 surfaces
    // these in the formatted message body but doesn't expose a `data` field).
    const joined = parts.join(" || ");
    for (const [sel, name] of Object.entries(KNOWN_SELECTORS)) {
        if (joined.toLowerCase().includes(sel) && !joined.includes(name)) {
            parts.push(name);
        }
    }
    return parts.join(" || ");
}
