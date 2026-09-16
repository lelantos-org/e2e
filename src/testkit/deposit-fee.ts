// The fee note every deposit mints.
//
// A deposit occupies two leaves: the depositor's note and a note paying whoever
// flushes the batch. The contract mints the second leaf unconditionally, so
// every `buildDeposit` call needs one, including in tests concerned only with
// the first leaf.
//
// `wallet.deposit` builds this note itself, pricing it off
// `/v1/deposit/estimate`. These helpers cover the direct `buildDeposit` path,
// which bypasses the wallet.
//
// # Which one to use
//
// This stack runs with shielded fees on: the relayer trial-decrypts the fee
// leaf and flushes only what pays it. A deposit whose fee note is addressed
// elsewhere is skipped indefinitely with "fee note is not addressed to this
// relayer". Anything expecting a flush must use `relayerFeeNote`;
// `unflushableFee` is only for tests that assert a revert at submit time and
// never reach a flush.

import { decodeAddress, type Field, type Jubjub } from "@lelantos-org/sdk/primitives";
import type { buildDeposit } from "@lelantos-org/sdk/protocol";
import type { RelayerClient } from "@lelantos-org/sdk/services";

import { RELAYER_FEE_ADDRESS } from "../protocol/shielded-fee.js";
import { rngForOutput } from "../scenario.js";

/** What `buildDeposit` wants under `fee`. */
export type DepositFeeArg = Parameters<typeof buildDeposit>[0]["fee"];

type Recipient = DepositFeeArg["recipient"];

/** The two randomness sources `buildDeposit` draws from, in draw order. */
export interface FeeRng {
    rng: () => Field;
    auxRng: () => Field;
}

/**
 * What the relayer charges to flush one deposit in `asset`, in circuit units.
 *
 * Read from `/v1/deposit/estimate` rather than hardcoded: it is derived from
 * live gas, and the relayer re-derives it when the deposit surfaces. A constant
 * would hold until gas moved and would then strand deposits until their cancel
 * delay.
 *
 * Separate from `relayerFeeNote` so a test minting several deposits pays for
 * one quote rather than one per deposit.
 */
export async function quoteDepositFee(
    relayer: RelayerClient,
    chainId: bigint,
    asset: bigint,
): Promise<bigint> {
    const estimate = await relayer.estimateDeposit(chainId);
    const quote = estimate.fees.find(
        (f) => f.assetId !== undefined && BigInt(f.assetId) === asset,
    );
    if (quote?.circuitAmount === undefined) {
        throw new Error(
            `relayer quoted no deposit fee for asset ${asset}; it will not flush a deposit in it`,
        );
    }
    return BigInt(quote.circuitAmount);
}

/**
 * A fee note worth `value`, addressed to the relayer this stack runs.
 *
 * `asset` names the asset the note is paid in when it is not the deposit's
 * own; the pool then pulls it as a second token. Omitted, it follows the
 * deposit.
 */
export function relayerFeeNote(
    J: Jubjub,
    value: bigint,
    rngs: FeeRng,
    asset?: bigint,
): DepositFeeArg {
    return feeNote(decodeAddress(J, RELAYER_FEE_ADDRESS), value, rngs, asset);
}

/**
 * A zero-value fee note addressed to the depositor.
 *
 * The leaf is well-formed and the deposit is escrowed, but no relayer will
 * flush it, so the payer's funds sit until they cancel. Correct only for a test
 * that asserts the submit reverts; use `relayerFeeNote` everywhere else.
 */
export function unflushableFee(
    recipient: Recipient,
    rngs: FeeRng,
    /**
     * A valued note in another asset instead of the zero-value self-pad: still
     * addressed away from the relayer, so still never flushed, but escrowed on
     * the pool's two-token path. For exercising the two-token cancel.
     */
    paid?: { value: bigint; asset: bigint },
): DepositFeeArg {
    return feeNote(recipient, paid?.value ?? 0n, rngs, paid?.asset);
}

/**
 * The per-note randomness `buildDeposit` takes for either leaf, drawn in a
 * fixed order.
 *
 * Both leaves draw from the same counters, so a test's draws stay sequential
 * and reproducible: interleaving a second source makes reruns diverge.
 */
export function noteRandomness({ rng, auxRng }: FeeRng): Parameters<typeof buildDeposit>[0]["output0"] {
    return { rho: rng(), rcm: rng(), rcv: rng(), rcvDep: rng(), aux: rngForOutput(auxRng) };
}

function feeNote(
    recipient: Recipient,
    value: bigint,
    rngs: FeeRng,
    asset?: bigint,
): DepositFeeArg {
    return {
        recipient,
        value,
        ...(asset !== undefined ? { asset } : {}),
        ...noteRandomness(rngs),
    };
}
