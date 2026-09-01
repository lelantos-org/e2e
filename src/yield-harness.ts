// Test-side controls for the yield stack: read the pool's own measure of what a
// yield asset's units are worth, and move the vault's index under it. Deposits
// and withdrawals against a yield id run through the SDK's `Wallet` exactly as
// a plain id does — the id is the only difference — so there is no wrapper for
// them here.
//
// The asset itself comes from `env.yield.asset(id)`; every function below takes
// that record rather than re-resolving it.

import { ethers } from "ethers";

import type { YieldRate } from "@lelantos-org/sdk";

import { MASP_YIELD_ABI, MOCK_ERC4626_ABI, YIELD_VENUE_ABI } from "./protocol/abi.js";
import { env, type YieldAssetEnv } from "./env.js";

/**
 * One yield asset's pool-side state, as the contract stores it.
 *
 * The fields a test prices against, rather than the whole tuple: `perfBps` and
 * `lastIdx` are the two inputs to `YieldOps._accruePerf` that are not derivable
 * from the rate, and `accruedFeeNormalized` is where both the performance fee
 * and the unshield fee land.
 */
export interface YieldStateView {
    perfBps: number;
    bufferBps: number;
    halted: boolean;
    totalNormalized: bigint;
    accruedFeeNormalized: bigint;
    idle: bigint;
    /** High-water mark the performance fee is charged against. */
    lastIdx: bigint;
}

/** The pool's stored state and the rate derived from it, read together. */
export interface YieldSnapshot {
    state: YieldStateView;
    rate: YieldRate;
}

/**
 * Both views of one asset, off a single `yieldState` read.
 *
 * Read together because they are asserted together: taken as two calls the
 * pool can move between them, and an expectation priced off a `supply` from
 * one block and a `lastIdx` from the next mirrors no arithmetic the contract
 * ever ran.
 */
export async function yieldSnapshot(
    provider: ethers.Provider,
    asset: YieldAssetEnv,
): Promise<YieldSnapshot> {
    const s = await masp(provider).yieldState(asset.id);
    const venue = new ethers.Contract(asset.venue, YIELD_VENUE_ABI, provider);
    return {
        state: {
            perfBps: Number(s.perfBps),
            bufferBps: Number(s.bufferBps),
            halted: s.halted,
            totalNormalized: s.totalNormalized,
            accruedFeeNormalized: s.accruedFeeNormalized,
            idle: s.idle,
            lastIdx: s.lastIdx,
        },
        rate: {
            // `gross` is the venue position plus the pool's idle balance;
            // `supply` is every normalized unit outstanding against it, the
            // depositors' and the accrued performance fee's alike.
            gross: (await venue.totalAssets()) + s.idle,
            supply: s.totalNormalized + s.accruedFeeNormalized,
        },
    };
}

/**
 * What the pool itself divides by, as the `{ gross, supply }` pair the SDK's
 * `toTokenUnitsAtRate` takes.
 *
 * The pair rather than {@link yieldIndex}: the index is floored where the pool
 * reports it, so a charge sized through it can land under what the contract
 * takes, and a Permit2 `maxTotal` signed off that figure is refused.
 */
export async function yieldRate(
    provider: ethers.Provider,
    asset: YieldAssetEnv,
): Promise<YieldRate> {
    return (await yieldSnapshot(provider, asset)).rate;
}

/** The pool's reported index, RAY-scaled. `RAY` while nothing is outstanding. */
export async function yieldIndex(
    provider: ethers.Provider,
    asset: YieldAssetEnv,
): Promise<bigint> {
    return await masp(provider).index(asset.id);
}

/**
 * Credit the vault with `amt` more underlying, moving the index above `RAY`.
 *
 * `signer` must hold the underlying and have approved the vault: the mock pulls
 * it in, which is what makes the gain real rather than a bookkeeping entry the
 * pool's own accounting would disagree with.
 */
export async function vaultEarn(
    signer: ethers.Signer,
    asset: YieldAssetEnv,
    amt: bigint,
): Promise<void> {
    await send(signer, asset, (v) => v.earn(amt));
}

/** Burn `amt` of the vault's underlying, moving the index below `RAY`. */
export async function vaultLose(
    signer: ethers.Signer,
    asset: YieldAssetEnv,
    amt: bigint,
): Promise<void> {
    await send(signer, asset, (v) => v.lose(amt));
}

/**
 * Cap what the vault will pay back on a withdrawal, so the pool has to refill
 * its idle buffer from a venue that cannot return everything at once. `0n`
 * lifts the cap.
 */
export async function setVaultLiquidityCap(
    signer: ethers.Signer,
    asset: YieldAssetEnv,
    cap: bigint,
): Promise<void> {
    await send(signer, asset, (v) => v.setLiquidityCap(cap));
}

function masp(provider: ethers.Provider): ethers.Contract {
    return new ethers.Contract(env.maspAddress, MASP_YIELD_ABI, provider);
}

/** Every vault mutator is one call awaited to a receipt; this is that. */
async function send(
    signer: ethers.Signer,
    asset: YieldAssetEnv,
    call: (vault: ethers.Contract) => Promise<ethers.ContractTransactionResponse>,
): Promise<void> {
    await (await call(new ethers.Contract(asset.vault, MOCK_ERC4626_ABI, signer))).wait();
}
