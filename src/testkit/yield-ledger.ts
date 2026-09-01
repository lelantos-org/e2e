// The pool's books for a yield asset, observed and cross-checked against the
// chain they claim to describe.
//
// A yield id keeps two numbers that a plain id does not: `gross`, the value
// standing behind every outstanding unit, and `idle`, the part of it the pool
// holds directly rather than at the venue. Neither is visible from a
// withdrawer's balance — a pool that redeemed its whole position on every exit,
// one that never refilled its buffer, and one that got it exactly right all pay
// the same recipient the same amount.
//
// So the yield files assert the books rather than the payout, and every one of
// them needs the same two things: a snapshot pairing the pool's state with the
// ERC-20 balances of that same block, and the invariant every call must leave
// behind. Both live here.

import { expect } from "vitest";

import type { ethers } from "ethers";

import type { YieldAssetEnv } from "../env.js";
import type { Erc20Helpers } from "../scenario.js";
import { snapshotBalances, trackedAddrs } from "../scenario.js";
import { yieldSnapshot, type YieldSnapshot } from "../yield-harness.js";

/**
 * A pool snapshot and the token balances of the same block.
 *
 * Taken together because they are asserted against each other: read as two
 * calls, the pool can move between them and `idle` no longer describes the
 * balance it is compared to.
 */
export interface Observed extends YieldSnapshot {
    balances: Record<string, bigint>;
}

/** Observe `asset`: the pool's yield state plus the balances of `addrs`. */
export async function observeYield(
    provider: ethers.Provider,
    asset: YieldAssetEnv,
    token: Erc20Helpers,
    addrs: Record<string, string> = trackedAddrs(),
): Promise<Observed> {
    return {
        ...(await yieldSnapshot(provider, asset)),
        balances: await snapshotBalances(token, addrs),
    };
}

/**
 * What every call that pays a yield asset out must leave behind, whatever route
 * it took to find the tokens.
 *
 * Two claims, and each catches what the other cannot:
 *
 *   * `gross` fell by exactly `paid`. A draw moves value between the venue leg
 *     and the idle leg without changing their sum, so anything else that moved
 *     the total — a redemption booked at the wrong size, a refill taken out of
 *     the wrong leg — shows up here and nowhere else.
 *   * the pool's own ERC-20 balance moved with `idle`. That makes `idle` a
 *     claim on tokens the pool actually holds rather than a number in storage.
 *
 * The balance is compared as a delta because a yield id shares its ERC-20 with
 * the plain id it shadows, so the balance itself says nothing about either.
 */
export function expectPoolSettled(before: Observed, after: Observed, paid: bigint): void {
    expect(after.rate.gross, "only the payout left the pool").toBe(before.rate.gross - paid);
    expect(
        after.balances.masp - before.balances.masp,
        "the pool's token balance tracks idle",
    ).toBe(after.state.idle - before.state.idle);
}
