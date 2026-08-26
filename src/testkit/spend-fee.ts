// What a spend paid the relayer, derived from its result.
//
// The shielded fee is an output note addressed to the relayer, not a field on
// the result, so there is nothing to read directly. What the result does carry
// is the conservation the circuit enforces:
//
//     inputSum = sent + change + fee
//
// so the fee is whatever the inputs covered beyond the payment and the change.
//
// Tests derive it rather than hardcoding a number because the amount is priced
// off live gas, and a literal would hold only until the next block moved the
// gas price.

import type { SwapResult, TransferResult, WithdrawResult } from "@lelantos-org/sdk";

/**
 * The fee a spend paid, in circuit units.
 *
 * Every spending result carries the same three fields, so this covers
 * transfers, withdraws and swaps alike.
 *
 * Zero on a subsidised chain, where the wallet attaches no fee note, so an
 * assertion written in terms of this holds either way.
 */
export function feePaid(r: TransferResult | WithdrawResult | SwapResult): bigint {
    const fee = BigInt(r.inputSum) - BigInt(r.sent) - BigInt(r.change);
    if (fee < 0n) {
        throw new Error(
            `transfer ${r.txHash}: inputs ${r.inputSum} do not cover sent ${r.sent} ` +
                `plus change ${r.change} — the result does not describe a conserving spend`,
        );
    }
    return fee;
}
