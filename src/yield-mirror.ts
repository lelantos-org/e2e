// Mirrors of the arithmetic in `contracts/src/yield/YieldOps.sol`.
//
// A yield id's figures are not knowable in advance the way a plain id's are.
// Notes are held in NORMALIZED units, and what one unit converts to is
// `gross / supply` — a ratio that moves with the venue, with the performance
// fee's mint, and with whatever the files before this one left in the pool. So
// every yield expectation in the suite is computed from a `{ gross, supply }`
// pair read immediately before the call under test, rather than written out as
// a token figure by hand.
//
// Deliberately a mirror rather than an approximation: a tolerance wide enough
// to absorb the contract's rounding would also absorb a fee taken at the wrong
// rate, and that is the class of bug these exist to catch. A performance fee
// that silently charged 0%, or charged against principal rather than growth,
// leaves every balance assertion in the suite passing.
//
// The cost is that a change in `YieldOps` has to land here too. It surfaces as
// an exact-equality failure naming the figure that moved, which is the intent:
// a rounding mode or a fee base that changed quietly is precisely what should
// fail a test.

import { RAY } from "@lelantos-org/sdk";
import type { YieldRate } from "@lelantos-org/sdk";

import { circuitFee } from "./protocol/amounts.js";
import type { YieldSnapshot, YieldStateView } from "./yield-harness.js";

/** `Fees.BPS_DENOMINATOR`. Every rate in the pool is a share of this. */
export const BPS = 10_000n;

/** `Math.mulDiv(a, b, d, Ceil)`. */
export const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;

/**
 * Normalized units to underlying, floored — `YieldOps._toUnderlying`.
 *
 * `scale` governs the empty pool only, where there is no ratio yet and one unit
 * is worth exactly `scale` base units.
 */
export function toUnderlying(n: bigint, rate: YieldRate, scale: bigint): bigint {
    return rate.supply === 0n ? n * scale : (n * rate.gross) / rate.supply;
}

/** What `YieldOps._accruePerf` charges and mints. */
export interface PerfAccrual {
    /** The treasury's share of the growth, in token units. */
    cut: bigint;
    /** Normalized units minted to the treasury to collect `cut`. */
    units: bigint;
}

const NO_ACCRUAL: PerfAccrual = { cut: 0n, units: 0n };

/**
 * The accrual every state-changing yield call runs before it prices anything.
 *
 * The performance fee cannot be deducted from a payout the way the unshield fee
 * is: that would need the note's cost basis, and notes are shielded and
 * fungible. It is charged by MINTING normalized units to the treasury, which
 * dilutes every holder by the treasury's share of the gain. `units` is the
 * fee-share solve that leaves those units worth exactly `cut` once they have
 * diluted the supply.
 *
 * Growth is measured against a high-water mark, so a venue that has lost value
 * accrues nothing until `gross` passes its old peak.
 */
export function accruePerf(
    state: Pick<YieldStateView, "perfBps" | "lastIdx">,
    rate: YieldRate,
    scale: bigint,
): PerfAccrual {
    const perfBps = BigInt(state.perfBps);
    // Rounded up against the treasury, so rounding cannot manufacture growth.
    const hwm = mulDivCeil(rate.supply * scale, state.lastIdx, RAY);
    if (perfBps === 0n || rate.supply === 0n || rate.gross <= hwm) return NO_ACCRUAL;

    const cut = ((rate.gross - hwm) * perfBps) / BPS;
    if (cut === 0n) return NO_ACCRUAL;

    const units = (cut * rate.supply) / (rate.gross - cut);
    // The contract bails on a mint that floors to nothing, leaving the mark
    // untouched so the growth stays claimable once it is worth a unit.
    if (units === 0n) return NO_ACCRUAL;
    return { cut, units };
}

/**
 * The supply a call prices against: the one that already includes the units the
 * accrual just minted.
 *
 * `gross` needs no such adjustment — minting units moves no tokens.
 */
export function supplyAfterAccrual(snap: YieldSnapshot, scale: bigint): bigint {
    return snap.rate.supply + accruePerf(snap.state, snap.rate, scale).units;
}

/**
 * What `YieldOps.unshield` pays out for a published count of `nOut`.
 *
 * The unshield fee is taken in normalized units off the count being published,
 * exactly as it is for a plain asset, and the remainder is converted at the
 * post-accrual rate. Rounded down, against the withdrawer, so the pool is never
 * left owing more than it holds.
 */
export function unshieldNet(nOut: bigint, snap: YieldSnapshot, scale: bigint): bigint {
    const net = nOut - circuitFee(nOut);
    return (net * snap.rate.gross) / supplyAfterAccrual(snap, scale);
}

/**
 * `YieldOps._refillFor`: the idle buffer the pool wants left behind once `need`
 * has gone.
 *
 * A venue draw takes the shortfall plus this, restoring the buffer in the same
 * hop so the withdrawals that follow do not each reach the venue.
 */
export function refillFor(gross: bigint, need: bigint, bufferBps: number): bigint {
    return ((gross > need ? gross - need : 0n) * BigInt(bufferBps)) / BPS;
}
