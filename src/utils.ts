import { BABYJUB_SUBGROUP_ORDER, type Field } from "@lelantos-org/sdk/crypto";

/** A field element as a 0x-prefixed 32-byte hex string. */
export function cmToHex(v: Field): string {
    return "0x" + v.toString(16).padStart(64, "0");
}

// LCG scalar source in 𝔽_subgroup; same seed yields the same sequence.
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

/**
 * Poll `predicate` until it returns a truthy value, or fail with a message
 * naming the last error.
 *
 * Predicate exceptions are swallowed while polling: warm-up reads (connection
 * refused, not yet indexed) are expected to fail until the service is ready.
 * The last one is reported on timeout, which distinguishes "the service never
 * came up" from "the row never landed" and from a bug in the predicate.
 */
export async function pollUntil<T>(
    predicate: () => Promise<T | null | undefined>,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 500;
    const label = opts.label ?? "predicate";
    const start = Date.now();
    let lastErr: unknown;
    let attempts = 0;
    while (true) {
        attempts++;
        try {
            const v = await predicate();
            if (v) return v;
            lastErr = undefined;
        } catch (e) {
            lastErr = e;
        }
        if (Date.now() - start > timeoutMs) {
            const elapsed = Date.now() - start;
            const why = lastErr === undefined
                ? "predicate never returned a value"
                : `last error: ${summarize(lastErr)}`;
            // Duplicated into the message because vitest's CI reporters do not
            // reliably print `cause`.
            throw new Error(
                `pollUntil(${label}) timed out after ${elapsed}ms (${attempts} attempts) — ${why}`,
                { cause: lastErr },
            );
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

function summarize(e: unknown): string {
    const msg = e instanceof Error ? (e.message || e.constructor.name) : String(e);
    return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}
