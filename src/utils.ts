// Generic, dependency-light helpers that don't belong to any one
// stack/test concern. Hex codecs, deterministic randomness, log
// formatter, signal awaiter.

import { BABYJUB_SUBGROUP_ORDER, type Field } from "@lelantos-org/sdk";

// ──────────────────────────────────────────────────────────────────────
// Hex codecs
// ──────────────────────────────────────────────────────────────────────

/// 0x-hex of `b`. Matches what the contracts + indexers emit on the wire.
export function bytesToHex(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

/// Inverse of `bytesToHex`. Accepts both `0x…` and bare hex.
export function hexToBytes(s: string): Uint8Array {
    const stripped = s.startsWith("0x") ? s.slice(2) : s;
    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(stripped.slice(2 * i, 2 * i + 2), 16);
    }
    return out;
}

/// 32-byte 0x-hex of a BN254 scalar. Matches the on-chain mapping shape
/// for nullifiers + commitments + roots.
export function fieldToHex32(v: Field): string {
    return "0x" + v.toString(16).padStart(64, "0");
}

/// Alias of `fieldToHex32` for sites where the value is a commitment —
/// preserves intent at the call site.
export const cmToHex = fieldToHex32;

/// Alias of `fieldToHex32` for nullifiers.
export const nfToHex = fieldToHex32;

// ──────────────────────────────────────────────────────────────────────
// Deterministic randomness
// ──────────────────────────────────────────────────────────────────────

/// LCG-based scalar source. Each call returns a non-zero scalar in
/// 𝔽_subgroup. Tests use this so reruns land on identical rho/rcm/rcv
/// + ECDH ephemerals — debugging stays deterministic.
export function counter(seed: bigint): () => Field {
    let n = seed;
    return () => {
        n += 1n;
        const v = (n * 0x9e3779b97f4a7c15n) % BABYJUB_SUBGROUP_ORDER;
        return v === 0n ? 1n : v;
    };
}

// ──────────────────────────────────────────────────────────────────────
// Logging + lifecycle
// ──────────────────────────────────────────────────────────────────────

/// Prefix every line with `[e2e]`. One log surface for the whole runner
/// makes grepping the test transcript trivial.
export function log(...xs: unknown[]): void {
    console.log("[e2e]", ...xs);
}

/// Resolves on the next SIGINT/SIGTERM. Used by long-lived CLI commands
/// (`up`) to block the main loop until the user ctrl-c's.
export function waitForSignal(): Promise<void> {
    return new Promise((resolve) => {
        process.on("SIGINT", () => resolve());
        process.on("SIGTERM", () => resolve());
    });
}

// ──────────────────────────────────────────────────────────────────────
// Polling
// ──────────────────────────────────────────────────────────────────────

/// Run `predicate` every `intervalMs` until it returns a truthy value;
/// throw after `timeoutMs`. Predicate exceptions are swallowed —
/// useful for "wait until the service responds 200" patterns where
/// connection refused / not-yet-indexed are expected during warm-up.
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
            // swallow — keep polling
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
