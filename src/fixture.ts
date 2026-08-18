// Per-file test fixtures: what every `describe` needs before it can do
// anything, and how a file expresses a multi-step story without leaking state
// between sibling `it`s.

import type { AssetId, Wallet } from "@lelantos-org/sdk";
import type { Field } from "@lelantos-org/sdk/crypto";

import { fundPayerForAsset, setupHarness, type Harness } from "./harness.js";
import type { Erc20Helpers } from "./scenario.js";
import { createTestWallet } from "./wallet.js";

/**
 * The SDK wallet handle tests drive.
 *
 * Distinct from `scenario.ts`'s `CircuitWallet`, which is the raw key bundle
 * the direct `buildDeposit`/`buildSpend` paths take.
 */
export type SdkWallet = Wallet;

/**
 * Memoise an async step.
 *
 * Test files often tell a story: deposit, then transfer the note, then try to
 * replay it. Writing that as three `it`s that hand state to each other through
 * module-level `let`s means no single `it` can be run with `-t`, and one
 * failure cascades into unrelated ones.
 *
 * Instead, each step is a `once`-wrapped stage that later stages `await`. The
 * dependency becomes explicit, the work still happens exactly once per file,
 * and running one `it` alone pulls in precisely the prefix it needs.
 *
 * A rejection is cached and re-thrown to every caller: a setup step that
 * failed must not be silently retried by the next `it` and half-succeed.
 */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
    let p: Promise<T> | undefined;
    return () => (p ??= fn());
}

/**
 * Mint (or wrap) `amount` base units of `asset` to the payer and approve
 * Permit2. Use `withFee(...)` to size it — a deposit pulls principal + fee.
 */
export interface FundSpec {
    asset: AssetId;
    amount: bigint;
}

export interface FileFixture<K extends string> {
    h: Harness;
    /** One wallet per key in `nsks`, under the same names. */
    w: Record<K, SdkWallet>;
    /** ERC-20 handle for a funded asset, for balance snapshots. */
    token(asset: AssetId): Erc20Helpers;
}

/**
 * Boot the shared stack handle, fund the payer, and build this file's wallets.
 *
 * Replaces the six lines of `let h` / `let alice` / `beforeAll` that opened
 * every test file:
 *
 *     const { h, w, token } = await setupFile({
 *         nsks: TEST_NSK.fullFlow,
 *         fund: [{ asset: ASSET, amount: withFee(1000n) }],
 *     });
 *
 * `nsks` takes a `TEST_NSK` entry directly, so wallets come back under the
 * names the registry already uses (`w.alice`, `w.bob`).
 */
export async function setupFile<K extends string = never>(opts: {
    nsks?: Record<K, Field>;
    fund?: readonly FundSpec[];
} = {}): Promise<FileFixture<K>> {
    const h = await setupHarness();

    const tokens = new Map<string, Erc20Helpers>();
    for (const { asset, amount } of opts.fund ?? []) {
        tokens.set(asset.toString(), await fundPayerForAsset(h, asset, amount));
    }

    const w = {} as Record<K, SdkWallet>;
    for (const [name, nsk] of Object.entries(opts.nsks ?? {}) as [K, Field][]) {
        w[name] = await createTestWallet(nsk);
    }

    return {
        h,
        w,
        token: (asset) => {
            const t = tokens.get(asset.toString());
            if (!t) throw new Error(`setupFile: asset ${asset} was not funded`);
            return t;
        },
    };
}
