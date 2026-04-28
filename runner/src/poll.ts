// Wait until `predicate` returns a truthy value, polling every `intervalMs`.
// Throws after `timeoutMs`.

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
            // ignore — keep polling
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms`);
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
}
