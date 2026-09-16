// Assert that a promise rejects, and that it rejected for the reason the test
// is about.
//
// Matching goes through `errorText`, which flattens an error's whole cause
// chain and decodes known selectors. A bare `rejects.toThrow(/…/)` matches the
// message only, and most of these reverts do not put their reason there.

import { isWalletError, type WalletErrorCode } from "@lelantos-org/sdk";

import { errorText } from "../protocol/reverts.js";

export interface ExpectRevertOpts {
    /**
     * The SDK error code the rejection must carry, checked with
     * `isWalletError(err, code)`. Omit for a rejection that does not come out of
     * the SDK wallet (a direct ethers call).
     */
    code?: WalletErrorCode;
    match?: RegExp | string;
}

// Ethers v6 surfaces revert data on message/reason/shortMessage/data depending
// on tx vs call vs estimateGas, so all of them are checked, and `cause` is
// walked so chain reverts wrapped in SDK errors still match.
export async function expectRevert(
    p: Promise<unknown>,
    spec?: RegExp | string | ExpectRevertOpts,
): Promise<Error> {
    const outcome = await capture(p);
    if (!outcome.rejected) throw new Error("expectRevert: expected promise to reject, but it resolved");
    // A rejection carrying no error is still a rejection; wrap it so matching
    // and the returned value have something to work on.
    const err = outcome.reason instanceof Error
        ? outcome.reason
        : new Error(`rejected with non-Error value: ${String(outcome.reason)}`, { cause: outcome.reason });
    if (spec === undefined) return err;

    const opts = normalizeSpec(spec);
    if (opts.code !== undefined && !isWalletError(err, opts.code)) {
        const got = isWalletError(err) ? err.code : err.constructor?.name ?? typeof err;
        throw failure(`expected a WalletError with code=${opts.code}, got ${got}`, err);
    }
    if (opts.match !== undefined) {
        const re = typeof opts.match === "string" ? new RegExp(opts.match) : opts.match;
        const haystack = errorText(err);
        if (!re.test(haystack)) throw failure(`reject did not match ${re} — got: ${haystack}`, err);
    }
    return err;
}

async function capture(p: Promise<unknown>): Promise<{ rejected: false } | { rejected: true; reason: unknown }> {
    try {
        await p;
        return { rejected: false };
    } catch (reason) {
        return { rejected: true, reason };
    }
}

function normalizeSpec(spec: NonNullable<Parameters<typeof expectRevert>[1]>): ExpectRevertOpts {
    if (spec instanceof RegExp || typeof spec === "string") return { match: spec };
    return spec;
}

function failure(reason: string, err: Error): Error {
    return new Error(`expectRevert: ${reason}${err.message ? ` (${err.message})` : ""}`);
}
