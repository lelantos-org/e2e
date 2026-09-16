// Per-file fixture for the yield specs, which share one shape of `beforeAll`.
//
// Kept apart from `yield-harness.ts`: that module is reached from the barrel
// (through `testkit/yield-ledger.ts`), and this one imports `fixture.ts`, which
// imports the barrel. Housing both in one file would close that loop.

import type { ethers } from "ethers";

import type { AssetId, WalletApi } from "@lelantos-org/sdk";
import type { Field } from "@lelantos-org/sdk/primitives";

import { withFee } from "./protocol/amounts.js";
import { env, type YieldAssetEnv } from "./env.js";
import { setupFile } from "./fixture.js";
import type { Erc20Helpers } from "./scenario.js";

/** What a yield file's `beforeAll` hands its cases. */
export interface YieldFixture {
    alice: WalletApi;
    /** The ERC-20 under the yield id, funded for the payer. */
    erc20: Erc20Helpers;
    provider: ethers.JsonRpcProvider;
    payer: ethers.Wallet;
    /** The deployed triple for the id: token, vault, venue. */
    ya: YieldAssetEnv;
}

/**
 * Boot a yield file: the stack handle, alice, the payer funded for one
 * `deposit` into yield id `asset`, and the id's deployed triple.
 */
export async function yieldFixture(opts: {
    nsks: { alice: Field };
    asset: AssetId;
    /** Circuit units alice deposits; `setupFile` adds the relayer-fee headroom. */
    deposit: bigint;
}): Promise<YieldFixture> {
    const f = await setupFile({
        nsks: opts.nsks,
        fund: [{ asset: opts.asset, amount: withFee(opts.deposit, opts.asset) }],
    });
    const { alice } = f.w;

    // As in `denominated-withdraw`: the relayer's `/chains` carries no
    // decimals for a mock token, and the yield branch additionally needs
    // `yieldEnabled` and the pool's `rate` to quote anything at all.
    await alice.asset(opts.asset, { refresh: true });

    return {
        alice,
        erc20: f.token(opts.asset),
        provider: f.h.provider,
        payer: f.h.payer,
        ya: env.yield.asset(opts.asset),
    };
}
