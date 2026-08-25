// `expectRevert` — assert that a promise rejects, and that it rejected for the
// reason the test is actually about.
//
// Split from the plain assertions because it is the one that needs to know how
// a revert is *shaped*: it matches against `errorText`, which flattens an
// error's whole cause chain and decodes known selectors. A bare
// `rejects.toThrow(/…/)` would match the message only, and most of these
// reverts do not put their reason there.

import { errorText } from "../protocol/reverts.js";

type ErrorCtor = new (...args: never[]) => Error;

export interface ExpectRevertOpts {
    class?: ErrorCtor;
    code?: string;
    match?: RegExp | string;
}

// Ethers v6 surfaces revert data on message/reason/shortMessage/data depending
// on tx vs call vs estimateGas; we check all of them, and walk `cause` so
// chain reverts wrapped in SDK errors like TxMiningError still match.
export async function expectRevert(
    p: Promise<unknown>,
    spec?: RegExp | string | ErrorCtor | ExpectRevertOpts,
): Promise<Error> {
    const err = await capture(p);
    if (!err) throw new Error("expectRevert: expected promise to reject, but it resolved");
    if (spec === undefined) return err;

    const opts = normalizeSpec(spec);
    if (opts.class && !(err instanceof opts.class)) {
        const gotName = (err as Error).constructor?.name ?? typeof err;
        throw failure(`expected instanceof ${opts.class.name}, got ${gotName}`, err);
    }
    const code = (err as { code?: unknown }).code;
    if (opts.code !== undefined && code !== opts.code) {
        throw failure(`expected code=${opts.code}, got code=${String(code)}`, err);
    }
    if (opts.match !== undefined) {
        const re = typeof opts.match === "string" ? new RegExp(opts.match) : opts.match;
        const haystack = errorText(err);
        if (!re.test(haystack)) throw failure(`reject did not match ${re} — got: ${haystack}`, err);
    }
    return err;
}

async function capture(p: Promise<unknown>): Promise<Error | undefined> {
    try { await p; return undefined; }
    catch (e) { return e as Error; }
}

function normalizeSpec(spec: NonNullable<Parameters<typeof expectRevert>[1]>): ExpectRevertOpts {
    if (typeof spec === "function") return { class: spec };
    if (spec instanceof RegExp || typeof spec === "string") return { match: spec };
    return spec;
}

function failure(reason: string, err: Error): Error {
    return new Error(`expectRevert: ${reason}${err.message ? ` (${err.message})` : ""}`);
}
