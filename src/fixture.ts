// Per-file test fixtures: what every `describe` needs before it can run, and
// how a file expresses a multi-step story without leaking state between
// sibling `it`s.

import type { AssetId, DenominationPolicy, Wallet } from "@lelantos-org/sdk";
import type { Field } from "@lelantos-org/sdk/crypto";

import { fundPayerForAsset, setupHarness, type Harness } from "./harness.js";
import type { Erc20Helpers } from "./scenario.js";
import { createTestWallet } from "./wallet.js";

/**
 * The SDK wallet handle tests drive.
 *
 * Distinct from `scenario.ts`'s `CircuitWallet`, which is the raw key bundle
 * the direct `buildDeposit` path takes.
 */
export type SdkWallet = Wallet;

/**
 * Memoise an async step.
 *
 * Test files often tell a story: deposit, transfer the note, then replay it.
 * Written as three `it`s handing state to each other through module-level
 * `let`s, no single `it` can be run with `-t` and one failure cascades into
 * unrelated ones.
 *
 * Each step is instead a `once`-wrapped stage that later stages await. The
 * dependency is explicit, the work happens once per file, and running one `it`
 * alone pulls in exactly the prefix it needs.
 *
 * A rejection is cached and re-thrown to every caller, so a failed setup step
 * is not silently retried by the next `it` and half-succeed.
 */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
    let p: Promise<T> | undefined;
    return () => (p ??= fn());
}

/**
 * Mint (or wrap) `amount` base units of `asset` for the payer and approve
 * Permit2. Size it with `withFee(...)`: a deposit pulls principal + fee.
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
 *     const { h, w, token } = await setupFile({
 *         nsks: TEST_NSK.fullFlow,
 *         fund: [{ asset: ASSET, amount: withFee(1000n) }],
 *     });
 *
 * `nsks` takes a `TEST_NSK` entry directly, so wallets come back under the
 * names the registry uses (`w.alice`, `w.bob`).
 */
export async function setupFile<K extends string = never>(opts: {
    nsks?: Record<K, Field>;
    fund?: readonly FundSpec[];
    /** Applied to every wallet this file builds. See `CreateWalletOpts`. */
    denominations?: DenominationPolicy;
} = {}): Promise<FileFixture<K>> {
    const h = await setupHarness();

    const tokens = new Map<string, Erc20Helpers>();
    for (const { asset, amount } of opts.fund ?? []) {
        tokens.set(asset.toString(), await fundPayerForAsset(h, asset, amount));
    }

    const w = {} as Record<K, SdkWallet>;
    for (const [name, nsk] of Object.entries(opts.nsks ?? {}) as [K, Field][]) {
        w[name] = await createTestWallet(
            nsk,
            opts.denominations !== undefined ? { denominations: opts.denominations } : {},
        );
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
