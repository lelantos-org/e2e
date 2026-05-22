import { BABYJUB_SUBGROUP_ORDER, type Field } from "@lelantos-org/sdk";

export function bytesToHex(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

export function hexToBytes(s: string): Uint8Array {
    const stripped = s.startsWith("0x") ? s.slice(2) : s;
    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(stripped.slice(2 * i, 2 * i + 2), 16);
    }
    return out;
}

export function fieldToHex32(v: Field): string {
    return "0x" + v.toString(16).padStart(64, "0");
}

export const cmToHex = fieldToHex32;
export const nfToHex = fieldToHex32;

// LCG scalar source in 𝔽_subgroup; same seed → same sequence across runs.
export function counter(seed: bigint): () => Field {
    let n = seed;
    return () => {
        n += 1n;
        const v = (n * 0x9e3779b97f4a7c15n) % BABYJUB_SUBGROUP_ORDER;
        return v === 0n ? 1n : v;
    };
}

export function log(...xs: unknown[]): void {
    console.log("[e2e]", ...xs);
}

export function waitForSignal(): Promise<void> {
    return new Promise((resolve) => {
        process.on("SIGINT", () => resolve());
        process.on("SIGTERM", () => resolve());
    });
}

// Predicate exceptions are swallowed: warm-up reads (connection refused,
// not-yet-indexed) are expected to fail until the service is ready.
export async function pollUntil<T>(
    predicate: () => Promise<T | null | undefined>,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 500;
    const label = opts.label ?? "predicate";
    const start = Date.now();
    while (true) {
        try {
            const v = await predicate();
            if (v) return v;
        } catch {
            // keep polling
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

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
        const haystack = collectMessage(err);
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

// Hand-mapped revert selectors → readable names. Used so expectRevert regexes
// can match on the error name when ethers v6 surfaces the raw `data` from a
// sub-call (e.g. Permit2's `SignatureExpired`) without decoding it.
const KNOWN_SELECTORS: Record<string, string> = {
    "0xcd21db4f": "SignatureExpired(deadline)",
    "0xcc34802d": "MustHaveDeposit()",
};

function collectMessage(e: Error): string {
    const parts: string[] = [];
    let cur: Error | undefined = e;
    while (cur && parts.length < 8) {
        const c = cur as Error & { reason?: string; shortMessage?: string; data?: unknown; cause?: unknown };
        for (const v of [c.message, c.reason, c.shortMessage]) {
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
