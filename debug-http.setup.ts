// TEMPORARY debug shim — logs non-2xx bodies and per-test memory growth.
import { afterEach } from "vitest";

const orig = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const res = await orig(input, init);
    if (!res.ok) {
        const url = typeof input === "string" ? input : (input?.url ?? String(input));
        const body = await res.clone().text().catch(() => "<unreadable>");
        console.error(`\n[debug-http] ${res.status} ${url}\n${body}\n`);
    }
    return res;
}) as typeof fetch;

const mb = (n: number) => Math.round(n / 1024 / 1024);
afterEach((ctx) => {
    const m = process.memoryUsage();
    console.error(
        `[debug-mem] rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}MB ext=${mb(m.external)}MB ab=${mb(m.arrayBuffers)}MB :: ${ctx.task.name}`,
    );
});
