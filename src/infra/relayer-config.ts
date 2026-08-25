// Renders `config/relayer.toml` with the values that only exist at boot.
//
// Most of the relayer's per-chain config reaches it through env overlays
// (`RELAYER_CHAIN_<id>_*`), which is why the committed TOML can hold zero
// addresses. `accepted_fee_tokens` has no such overlay and needs the ERC-20
// addresses forge just deployed, so it has to be written into the file.
//
// Rendering rather than committing real addresses keeps the checked-in config
// honest: anvil's deploy addresses are deterministic, so hardcoding them would
// work right up until the deploy script gained a contract, and would then fail
// as a fee quote for the wrong token rather than as a config error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR, E2E_DIR } from "./docker.js";

/** Placeholder line in `config/relayer.toml` this substitutes. */
const MARKER = "# @ACCEPTED_FEE_TOKENS@";

export interface FeeTokenSpec {
    symbol: string;
    address: string;
    decimals: number;
    /**
     * Oracle pair is `{native_symbol}-{quote_symbol}`, so every distinct value
     * here needs a file under `config/oracle/prices/`. They all quote in USD
     * for that reason — see that directory's README.
     */
    quoteSymbol: string;
}

/**
 * Write a rendered relayer.toml and return its host path.
 *
 * Written under the repo, not `os.tmpdir()`. The container mounts this by
 * path, and on macOS the Docker VM shares the project directory but not
 * `/var/folders` — a bind of an unshared file silently creates an empty
 * *directory* at the target instead, which surfaces as the relayer failing to
 * read its own config with "Is a directory".
 */
export function renderRelayerConfig(feeTokens: FeeTokenSpec[]): string {
    const template = readFileSync(join(CONFIG_DIR, "relayer.toml"), "utf8");
    if (!template.includes(MARKER)) {
        throw new Error(`relayer.toml is missing the ${MARKER} placeholder`);
    }

    const rendered = template.replace(MARKER, tomlFeeTokens(feeTokens));
    const dir = join(E2E_DIR, ".rendered");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "relayer.toml");
    writeFileSync(path, rendered);
    return path;
}

/**
 * An inline array of inline tables, not `[[chains.accepted_fee_tokens]]`.
 *
 * A sub-table would have to be placed after every scalar key of the `[[chains]]`
 * table it belongs to, which means knowing where that table ends. An inline
 * array is just another key and can sit anywhere inside it.
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
