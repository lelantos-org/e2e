// Renders `config/relayer.toml` with the values that exist only at boot.
//
// Most of the relayer's per-chain config reaches it through env overlays
// (`RELAYER_CHAIN_<id>_*`), which is why the committed TOML can hold zero
// addresses. `accepted_fee_tokens` has no such overlay and needs the ERC-20
// addresses the forge deploy produced, so it is written into the file. The
// bundle size is written in too, from the suite's own environment, so the file
// the relayer reads is the one place it is set.
//
// Rendering rather than committing real addresses: anvil's deploy addresses
// are deterministic, so hardcoded values would hold until the deploy script
// gained a contract, and would then surface as a fee quote for the wrong token
// rather than as a config error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR, E2E_DIR } from "./docker.js";

/** Placeholder lines in `config/relayer.toml` this substitutes. */
const MARKER = "# @ACCEPTED_FEE_TOKENS@";
const BUNDLE_MARKER = "# @BUNDLE_MAX_ITEMS@";

/**
 * Most operations the relayer lands in one `Bundler.execute`.
 *
 * `E2E_BUNDLE_MAX_ITEMS`, default 8. The suite runs with bundling on: its files
 * are sequential and mostly produce bundles of one, while
 * `tests/bundler-mixed.test.ts` holds the batcher to force larger ones and reads
 * this back as `RELAYER_BUNDLE_MAX_ITEMS` for its cap case. `1` sends every
 * operation alone. Bounds mirror `MAX_BUNDLE_ITEMS` in the relayer's config.
 */
export const BUNDLE_MAX_ITEMS = bundleMaxItems(process.env.E2E_BUNDLE_MAX_ITEMS);

function bundleMaxItems(raw: string | undefined): number {
    if (raw === undefined || raw === "") return 8;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 32) {
        throw new Error(`E2E_BUNDLE_MAX_ITEMS=${raw}: expected an integer in 1..=32`);
    }
    return n;
}

export interface FeeTokenSpec {
    symbol: string;
    address: string;
    decimals: number;
    /**
     * The oracle pair is `{native_symbol}-{quote_symbol}`, so every distinct
     * value here needs a file under `config/oracle/prices/`. All tokens quote
     * in USD to keep that to one pair; see that directory's README.
     */
    quoteSymbol: string;
}

/**
 * Write a rendered relayer.toml and return its host path.
 *
 * Written under the repo, not `os.tmpdir()`: the container mounts it by path,
 * and on macOS the Docker VM shares the project directory but not
 * `/var/folders`. Binding an unshared file creates an empty directory at the
 * target instead, which surfaces as the relayer failing to read its own config
 * with "Is a directory".
 */
export function renderRelayerConfig(feeTokens: FeeTokenSpec[]): string {
    const template = readFileSync(join(CONFIG_DIR, "relayer.toml"), "utf8");
    for (const marker of [MARKER, BUNDLE_MARKER]) {
        if (!template.includes(marker)) {
            throw new Error(`relayer.toml is missing the ${marker} placeholder`);
        }
    }

    const rendered = template
        .replace(MARKER, tomlFeeTokens(feeTokens))
        .replace(BUNDLE_MARKER, `bundle_max_items = ${BUNDLE_MAX_ITEMS}`);
    const dir = join(E2E_DIR, ".rendered");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "relayer.toml");
    writeFileSync(path, rendered);
    return path;
}

/**
 * An inline array of inline tables, not `[[chains.accepted_fee_tokens]]`.
 *
 * A sub-table would have to follow every scalar key of the `[[chains]]` table
 * it belongs to, which means knowing where that table ends. An inline array is
 * another key and can sit anywhere inside it.
 */
function tomlFeeTokens(tokens: FeeTokenSpec[]): string {
    if (tokens.length === 0) return "accepted_fee_tokens = []";
    const rows = tokens.map(
        (t) =>
            `    { symbol = ${str(t.symbol)}, address = ${str(t.address)}, ` +
            `decimals = ${t.decimals}, quote_symbol = ${str(t.quoteSymbol)} },`,
    );
    return ["accepted_fee_tokens = [", ...rows, "]"].join("\n");
}

function str(s: string): string {
    return JSON.stringify(s);
}
