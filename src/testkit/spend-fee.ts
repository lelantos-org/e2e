// What a spend paid the relayer, read from its result.
//
// The shielded fee is an output note addressed to the relayer. The result
// reports its value as `fees.relayer`, in the asset that paid it, or `null`
// when the relayer charged nothing.
//
// This stack's relayer charges for every spend (`RELAYER_CHAIN_<id>_SHIELDED_FEE_*`
// in `services.ts`), so `null` here is a wallet that skipped the fee, not a
// subsidised chain. Treating it as zero would let every `DEPOSIT - SEND - fee`
// assertion in the suite pass with the fee path broken.
//
// Tests read it rather than hardcoding a number because the amount is priced
// off live gas, and a literal would hold only until the next block moved the
// gas price. `testkit/relayer-fee.ts` then confirms the relayer's own wallet
// recovers a note worth exactly this, so a result that misreported its fee
// fails there.

import type { SwapResult, TransferResult, WithdrawResult } from "@lelantos-org/sdk";

/**
 * The fee a spend paid, in circuit units of the fee asset.
 *
 * Every spending result carries the same field, so this covers transfers,
 * withdraws and swaps alike.
 */
export function feePaid(r: TransferResult | WithdrawResult | SwapResult): bigint {
    const fee = r.fees.relayer;
    if (fee === null) {
        throw new Error(
            `${r.kind} ${r.txHash}: fees.relayer is null, but this stack's relayer charges for every spend`,
        );
    }
    if (fee.amount <= 0n) {
        throw new Error(
            `${r.kind} ${r.txHash}: fees.relayer is ${fee.amount} — a charged fee is never zero`,
        );
    }
    return fee.amount;
}
