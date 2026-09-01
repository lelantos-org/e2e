// Holding the suite until the relayer can quote every asset the deploy
// registered.
//
// `explorer-indexer` builds the `assets` table by replaying the chain, so the
// yield ids `DeployTestYield` registers land in it strictly after the plain
// ids `DeployTest` did, and the relayer reads that table through a 30s cache
// filled by the first request that needs it. A suite that starts depositing
// straight after boot can therefore meet a relayer holding a registry of plain
// ids only, and `Wallet.deposit` refuses the deposit outright:
//
//     the relayer charges to flush deposits but quoted no amount for asset 5,
//     so a deposit in it would never be flushed and would have to be
//     cancelled. It will take: WETH (id 1), mDAI (id 2), mWBTC (id 3).
//
// The relayer is behaving as documented there — a newly registered asset
// becomes quotable within the minute — so the wait belongs on this side, once,
// before any test runs. Left to the tests it is a race: whichever file deposits
// first pays the wait, and the yield files fail rather than wait because a fee
// note is denominated in the asset being moved and there is nothing to fall
// back to.

import { RelayerClient } from "@lelantos-org/sdk/relayer";

import { TIMEOUT } from "./testkit/timeouts.js";
import { pollUntil } from "./utils.js";

/**
 * Block until the relayer quotes a deposit fee for every id in `assetIds`.
 *
 * The whole registry rather than the yield ids alone: a plain id is subject to
 * the same lag, and asking for all of them is the same single request.
 *
 * A relayer that subsidises flushes quotes no fee at all and publishes no
 * `shieldedFeeAddress`; `resolveDepositFee` asks it for nothing, so there is
 * nothing to wait for and this returns on the first poll.
 */
export async function waitForQuotableAssets(
    relayerUrl: string,
    chainId: bigint,
    assetIds: readonly bigint[],
): Promise<void> {
    const relayer = new RelayerClient(relayerUrl);
    await pollUntil(
        async () => {
            const estimate = await relayer.estimateDeposit(chainId);
            if (estimate.shieldedFeeAddress === undefined) return true;
            const quoted = new Set(
                estimate.fees.flatMap((f) =>
                    f.assetId !== undefined && f.circuitAmount !== undefined
                        ? [BigInt(f.assetId)]
                        : [],
                ),
            );
            const missing = assetIds.filter((id) => !quoted.has(id));
            if (missing.length > 0) {
                // Thrown rather than returned as `null` so the timeout names
                // which ids never arrived, which separates an indexer that
                // stalled from a deploy that registered nothing.
                throw new Error(`still unquoted: ${missing.join(", ")}`);
            }
            return true;
        },
        {
            label: "relayer quotes every registered asset",
            timeoutMs: TIMEOUT.POLL_DEFAULT_MS,
            intervalMs: 2_000,
        },
    );
}
