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

import {
    MASP_ABI,
    MASP_YIELD_ABI,
    MASP_YIELD_MAINT_ABI,
    MOCK_ERC4626_ABI,
    YIELD_VENUE_ABI,
} from "./protocol/abi.js";
import { parseContractLogs } from "./protocol/logs.js";
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

/**
 * The venue leg of `gross`: what the pool's position at the vault is worth.
 *
 * Derived from a snapshot rather than read again, so the venue and idle legs a
 * test compares always come from one `yieldState` block. The two together are
 * `gross`, and a call that moves value between them without changing their sum
 * has moved nothing out of the pool.
 */
export function venueAssets(snap: YieldSnapshot): bigint {
    return snap.rate.gross - snap.state.idle;
}

/** Lifts a {@link setVaultLiquidityCap}: the mock's own default ceiling. */
export const LIQUIDITY_UNCAPPED = (1n << 256n) - 1n;

/**
 * The owner-pinned address `sweepNormalized` pays.
 *
 * Read off the pool rather than taken from the deploy's env block: the sweep's
 * destination is the pool's opinion of it, and a test that asserted against a
 * separately supplied address would still pass if the two had drifted apart.
 */
export async function poolTreasury(provider: ethers.Provider): Promise<string> {
    return (await new ethers.Contract(env.maspAddress, MASP_ABI, provider).treasury()) as string;
}

/**
 * Bring the performance fee up to date without waiting on user traffic.
 *
 * Permissionless. Called before a sweep so the units the sweep converts are
 * observable in `yieldState` beforehand: `sweepNormalized` accrues too, and
 * then clears what it accrued in the same transaction.
 */
export async function accrueYieldPerf(
    signer: ethers.Signer,
    asset: YieldAssetEnv,
): Promise<void> {
    await (await maint(signer).accruePerf(asset.id)).wait();
}

/** What one `sweepNormalized` retired and what it paid out for it. */
export interface SweptFee {
    /** Normalized units taken out of the accumulator. */
    units: bigint;
    /** Underlying transferred to the treasury for them, floored. */
    amount: bigint;
}

const NOTHING_SWEPT: SweptFee = { units: 0n, amount: 0n };

/**
 * Convert the treasury's units to underlying and transfer them.
 *
 * Permissionless caller, owner-pinned destination. A sweep with nothing to pay
 * out — an empty accumulator, or units worth less than one base unit — emits no
 * event and returns {@link NOTHING_SWEPT}, which is how a test asserts that a
 * second sweep takes nothing rather than throwing.
 */
export async function sweepYieldFee(
    signer: ethers.Signer,
    asset: YieldAssetEnv,
): Promise<SweptFee> {
    const masp = maint(signer);
    const receipt = await (await masp.sweepNormalized(asset.id)).wait();
    const [swept] = parseContractLogs(receipt, masp, "NormalizedFeeSwept");
    if (!swept) return NOTHING_SWEPT;
    return { units: swept.args.units as bigint, amount: swept.args.amount as bigint };
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
 * its idle buffer from a venue that cannot return everything at once.
 *
 * The cap is a ceiling on `maxWithdraw`, not a threshold: `0n` models a vault
 * whose markets are fully drawn, and the way to lift one is
 * {@link LIQUIDITY_UNCAPPED}. A test that sets a cap has to restore it — the
 * suite shares one vault per asset across every file.
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

/** The maintenance surface, bound to a signer: these are transactions. */
function maint(signer: ethers.Signer): ethers.Contract {
    return new ethers.Contract(env.maspAddress, MASP_YIELD_MAINT_ABI, signer);
}

/** Every vault mutator is one call awaited to a receipt; this is that. */
async function send(
    signer: ethers.Signer,
    asset: YieldAssetEnv,
    call: (vault: ethers.Contract) => Promise<ethers.ContractTransactionResponse>,
): Promise<void> {
    await (await call(new ethers.Contract(asset.vault, MOCK_ERC4626_ABI, signer))).wait();
}
