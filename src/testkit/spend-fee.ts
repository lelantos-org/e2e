// What a spend paid the relayer, recovered from its receipt.
//
// The shielded fee is an *output note* addressed to the relayer, not a field
// on the result, so there is nothing to read directly. What the receipt does
// carry is the conservation the circuit enforces:
//
//     inputSum = sent + change + fee
//
// so the fee is whatever the inputs covered beyond the payment and the change.
//
// Tests derive it rather than hardcoding a number because the amount is priced
// off live gas — `quoteDepositFee`'s counterpart on the spend side. A literal
// would pass until the next block moved the gas price.

import type { SwapResult, TransferResult, WithdrawResult } from "@lelantos-org/sdk";

/**
 * The fee a spend paid, in circuit units.
 *
 * Every spending result carries the same three fields, so this covers
 * transfers, withdraws and swaps alike — each pays the relayer out of its own
 * inputs.
 *
 * Zero on a subsidised chain, where the wallet attaches no fee note at all —
 * so an assertion written in terms of this stays correct either way.
 */
export function feePaid(r: TransferResult | WithdrawResult | SwapResult): bigint {
    const fee = BigInt(r.inputSum) - BigInt(r.sent) - BigInt(r.change);
    if (fee < 0n) {
        throw new Error(
            `transfer ${r.txHash}: inputs ${r.inputSum} do not cover sent ${r.sent} ` +
                `plus change ${r.change} — the receipt does not describe a conserving spend`,
        );
    }
    return fee;
}
