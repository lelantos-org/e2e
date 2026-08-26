// What a rejection looks like, and how to read one.
//
// `REVERT` names the guards the negative tests assert on; `errorText` is what
// those patterns are matched against. They live together because they work as a
// pair: several entries below match on a contract error name that appears in no
// message until `KNOWN_SELECTORS` decodes it out of raw revert data. A selector
// added without a matching entry fails open, and the pattern never matches.

import { ethers } from "ethers";

/**
 * Rejection reasons, matched by `expectRevert`.
 *
 * Each entry names the guard its test is about. Where several alternatives are
 * listed they are named states of that same guard (the relayer's pre-check
 * versus the pool's on-chain check, for instance), never a catch-all like
 * `/reverted/i`, which would let a misconfigured harness pass a negative test
 * without exercising anything.
 *
 * Contract error names come from `vendor/contracts`; relayer messages from
 * `AppError` in `vendor/backend/crates/relayer/src/domain/error.rs`. Selectors
 * are decoded by `KNOWN_SELECTORS` below for the cases where ethers surfaces
 * raw `data` from a sub-call.
 */
export const REVERT = {
    /**
     * A spend of an already-published nullifier. Two layers can catch it and
     * which one does is a timing detail, so both are accepted: the relayer
     * rejects with `AppError::NullifierAlreadySpent` (HTTP 409) as soon as it
     * has seen the first spend, and only a request that gets past it reaches
     * the pool's `NullifierSet.DoubleSpend()`.
     */
    NULLIFIER_SPENT: /nullifier already spent|DoubleSpend/,
    /**
     * The loser of a race between two spends of one note. The same guard as
     * above, but the winner is not yet indexed, so the relayer reports the
     * nullifier as in flight rather than spent. Which state appears depends on
     * how far the loser got.
     */
    NULLIFIER_CONTESTED: /nullifier in flight|nullifier already spent|DoubleSpend/,
    /**
     * Permit2 `InvalidAmount(uint256)` — requestedAmount exceeds the signed
     * `permitted.amount`, which the harness passes as `sig.maxTotal`.
     */
    PERMIT2_INVALID_AMOUNT: /InvalidAmount/,
    /** Permit2 `SignatureExpired(uint256)`. */
    PERMIT2_EXPIRED: /SignatureExpired/,
    /**
     * `SwapWrapper.AdapterNotAllowed()` — the adapter is not on the allowlist.
     * Reaches the client as the relayer's `ContractRejected` (HTTP 400), which
     * echoes the contract's revert data; the selector is decoded by
     * `KNOWN_SELECTORS` below.
     */
    ADAPTER_NOT_ALLOWED: /AdapterNotAllowed/,
    /**
     * The router rejects first: `UniV3Adapter` forwards `minOut` as
     * `amountOutMinimum`, so `MockSwapRouter02`'s require trips before
     * `SwapWrapper.InsufficientOut` is reached. Matching the wrapper's error
     * here would never fire.
     */
    SWAP_UNDER_MIN_OUT: /too little received/,
} as const;

// Revert selectors mapped to readable names, so `expectRevert` patterns can
// match on the error name when ethers v6 surfaces raw `data` from a sub-call
// (Permit2's `SignatureExpired`, for example) without decoding it.
//
// Derived from the signatures rather than hand-written hex: a wrong hand-typed
// selector fails open, and the test then reports "did not match" instead of the
// real reason.
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
 * Every piece of text an error carries: its own message, ethers' `reason` and
 * `shortMessage`, an HTTP `body`, raw revert `data` with known selectors
 * decoded, and the same again down the `cause` chain.
 *
 * Assertions match against this rather than `err.message`, because where a
 * reason lands varies between library versions.
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
        // `body` is the server's response text, which the SDK's `NetworkError`
        // may keep as its own field rather than folding into the message.
        // Reading both means an assertion works either way.
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
    // Also probe the joined text for embedded selectors: ethers v6 surfaces
    // these in the formatted message body without exposing a `data` field.
    const joined = parts.join(" || ");
    for (const [sel, name] of Object.entries(KNOWN_SELECTORS)) {
        if (joined.toLowerCase().includes(sel) && !joined.includes(name)) {
            parts.push(name);
        }
    }
    return parts.join(" || ");
}
