// Amount units and the fee arithmetic that sits between them.
//
// Three units are in play and mixing them is the most common way to write a
// wrong assertion:
//
//   * circuit units — what a `Wallet` balance and a `CircuitAmount` are in
//   * base units    — circuit units × the asset's scale; what an ERC-20
//                     `balanceOf` returns and what Permit2 signs over
//   * bps           — the pool's fee rate, applied in whichever unit the
//                     caller is already working in
//
// `feeFor` scales *first* and `circuitFee` does not, so the two floor at
// different magnitudes and are never interchangeable. See `circuitFee`.

import { type CircuitAmount, circuitAmount } from "@lelantos-org/sdk";

import { ASSET, scaleFor } from "./assets.js";

// 500 bps = 5%. Threaded into `DeployTest.s.sol` via `MASP_FEE_BPS`.
export const FEE_BPS = 500n;

/**
 * Circuit-unit amount literal. The SDK wallet takes `CircuitAmount`; tests
 * deal in whole units, so this is the shorthand at every call site.
 */
export const amt = (v: bigint): CircuitAmount => circuitAmount(v);

export function baseAmt(amount: bigint, asset: bigint = ASSET): bigint {
    return amount * scaleFor(asset);
}

// Matches contract math: fee = (publicIn * scale * feeBps) / 10000.
export function feeFor(amount: bigint, asset: bigint = ASSET): bigint {
    const inAmt = amount * scaleFor(asset);
    return (inAmt * FEE_BPS) / 10000n;
}

export function withFee(amount: bigint, asset: bigint = ASSET): bigint {
    return amount * scaleFor(asset) + feeFor(amount, asset);
}

/**
 * Fee in *circuit* units, for amounts that never get scaled to base units —
 * the debit a withdraw takes off a shielded balance, say. Mirrors the SDK's
 * `applyFee`; `feeFor` is the base-unit equivalent and scales first, so the
 * two are not interchangeable (they floor at different magnitudes).
 */
export function circuitFee(amount: bigint): bigint {
    return (amount * FEE_BPS) / 10_000n;
}

/**
 * What a deposit debits the payer, in base units.
 *
 * Three amounts, not two: the principal, the pool's protocol fee, and — since
 * every deposit mints a second leaf — the note paying whoever flushes it. The
 * relayer fee is *additive*, taken from the payer's tokens rather than out of
 * the deposit, so the depositor's shielded balance is still `amount`.
 *
 * This is the number Permit2 is asked to sign over. Signing `withFee` instead
 * reverts inside Permit2 with `InvalidAmount(maxTotal)` — the pool asks for
 * more than the payer permitted — which is a revert with no mention of fees.
 */
export function depositTotal(
    amount: bigint,
    relayerFee: bigint,
    asset: bigint = ASSET,
): bigint {
    return withFee(amount, asset) + relayerFee * scaleFor(asset);
}

/**
 * Circuit units of slack to mint on top of what a test spends, to cover
 * relayer fees.
 *
 * Funding happens in `beforeAll`, before the relayer can be asked what it
 * charges, and the charge moves with gas — so tests mint a margin rather than
 * a computed amount. Minting mock tokens is free; running short stalls a
 * deposit until its cancel delay.
 */
export const FEE_HEADROOM = 50n;
