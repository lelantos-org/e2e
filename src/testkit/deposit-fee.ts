// The fee note every deposit mints.
//
// A deposit occupies two leaves: the depositor's note and a note paying whoever
// flushes the batch. The contract mints the second leaf unconditionally, so
// every `buildDeposit` call needs one, including in tests concerned only with
// the first leaf.
//
// `Wallet.deposit` builds this note itself, pricing it off
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

import type { buildDeposit } from "@lelantos-org/sdk/bundle";
import type { Field, Jubjub } from "@lelantos-org/sdk/crypto";
import { decodeAddress } from "@lelantos-org/sdk/keys";
import type { RelayerClient } from "@lelantos-org/sdk/relayer";
import { ethers } from "ethers";

import { MASP_DEPOSIT_ABI } from "../protocol/abi.js";
import { parseContractLogs } from "../protocol/logs.js";

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

/** A fee note worth `value`, addressed to the relayer this stack runs. */
export function relayerFeeNote(J: Jubjub, value: bigint, rngs: FeeRng): DepositFeeArg {
    return feeNote(decodeAddress(J, RELAYER_FEE_ADDRESS), value, rngs);
}

/**
 * A zero-value fee note addressed to the depositor.
 *
 * The leaf is well-formed and the deposit is escrowed, but no relayer will
 * flush it, so the payer's funds sit until they cancel. Correct only for a test
 * that asserts the submit reverts; use `relayerFeeNote` everywhere else.
 */
export function unflushableFee(recipient: Recipient, rngs: FeeRng): DepositFeeArg {
    return feeNote(recipient, 0n, rngs);
}

/**
 * Randomness is drawn from the same counters as the depositor's note, so a
 * test's draws stay sequential and reproducible: `buildDeposit` consumes them
 * in a fixed order, and interleaving a second source makes reruns diverge.
 */
function feeNote(recipient: Recipient, value: bigint, { rng, auxRng }: FeeRng): DepositFeeArg {
    return {
        recipient,
        value,
        rho: rng(),
        rcm: rng(),
        rcv: rng(),
        rcvDep: rng(),
        aux: rngForOutput(auxRng),
    };
}

/** The fee leaf a deposit escrowed: what it is worth and which leaf it is. */
export interface DepositFeeLeaf {
    /** `feeIn`, in circuit units. Zero on a subsidised chain. */
    value: bigint;
    /** `feeCm`, the commitment the relayer must be able to recover. */
    cm: string;
}

/**
 * The fee leaf of a completed deposit, read from its `DepositEscrowed` log.
 *
 * The log rather than a fresh relayer quote: the wallet priced the note at
 * submit time, and a quote a few blocks later can differ because gas moves.
 * The event is what the payer was actually debited for, and it carries the
 * commitment alongside the amount, which is what lets the relayer side of the
 * payment be checked (see `testkit/relayer-fee.ts`).
 */
export async function depositFeeLeaf(
    provider: ethers.Provider,
    maspAddress: string,
    txHash: string,
): Promise<DepositFeeLeaf> {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt === null) throw new Error(`deposit ${txHash}: no receipt`);
    const masp = new ethers.Contract(maspAddress, MASP_DEPOSIT_ABI, provider);
    const escrowed = parseContractLogs(receipt, masp, "DepositEscrowed");
    if (escrowed.length === 0) {
        throw new Error(`deposit ${txHash}: no DepositEscrowed log`);
    }
    if (escrowed.length > 1) {
        throw new Error(
            `deposit ${txHash}: ${escrowed.length} DepositEscrowed logs; ` +
                "this helper assumes one deposit per transaction",
        );
    }
    return {
        value: BigInt(escrowed[0].args.feeIn as bigint),
        cm: escrowed[0].args.feeCm as string,
    };
}
