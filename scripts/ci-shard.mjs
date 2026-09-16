#!/usr/bin/env node
// Print the test files for one CI shard, balanced by measured duration.
//
//   node scripts/ci-shard.mjs <index> <total>     # index is 1-based
//
// Each shard is its own CI job with its own stack, so what matters is that no
// shard waits on a long one while another sits idle. `vitest --shard` splits by
// file hash, which put `bundler-mixed` (about a quarter of the suite on its own)
// next to other long files. This packs by duration instead: longest file first,
// each onto the least-loaded shard.
//
// Durations come from `ci/test-timings.json`: seconds of test work per file,
// stack boot excluded. A file missing from it — a new spec — counts as the
// median, so it lands somewhere reasonable until the table is refreshed. Every
// file under `tests/` is assigned to exactly one shard, whether or not it is
// in the table.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function testFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return testFiles(p);
        return e.name.endsWith(".test.ts") ? [relative(ROOT, p)] : [];
    });
}

const [index, total] = process.argv.slice(2).map(Number);
if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 1 || index > total) {
    console.error("usage: ci-shard.mjs <index 1..total> <total>");
    process.exit(2);
}

const timings = JSON.parse(readFileSync(join(ROOT, "ci/test-timings.json"), "utf8"));
const known = Object.values(timings).sort((a, b) => a - b);
const median = known.length > 0 ? known[Math.floor(known.length / 2)] : 1;

const files = testFiles(join(ROOT, "tests")).sort();
const weighted = files
    .map((file) => ({ file, secs: timings[file] ?? median }))
    // Heaviest first, path as a tie-break so the assignment is deterministic.
    .sort((a, b) => b.secs - a.secs || a.file.localeCompare(b.file));

const shards = Array.from({ length: total }, () => ({ secs: 0, files: [] }));
for (const w of weighted) {
    const lightest = shards.reduce((best, s) => (s.secs < best.secs ? s : best));
    lightest.files.push(w.file);
    lightest.secs += w.secs;
}

const mine = shards[index - 1];
console.error(
    `shard ${index}/${total}: ${mine.files.length} files, ~${mine.secs}s of test work ` +
        `(shards: ${shards.map((s) => s.secs).join(", ")}s)`,
);
console.log(mine.files.sort().join(" "));
