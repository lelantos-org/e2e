// Paying a deposit's relayer fee in another token, for every pair of tokens.
//
// `deposit-fee-asset.test.ts` walks one pairing in depth — an mDAI deposit
// paying in WETH, through both Permit2 strategies, cancellation and refusals.
// Those two assets share a scale (10^10), so a fee converted to base units
// with the *deposit* asset's scale instead of the fee asset's lands on exactly
// the same number and passes. mWBTC has 8 decimals and scale 1, so any pairing
// with it separates the two by ten orders of magnitude.
//
// The property, for every ordered pair (deposit asset A, fee asset B), A ≠ B:
//
//   * the payer is debited exactly `withFee(amount, A)` in A and exactly
//     `feeIn × scale(B)` in B, and the pool is credited the same;
//   * the escrow binds A as the deposit asset and B as the fee asset, and the
//     SDK's own report (`pulled`, `fees`) agrees with what moved on chain;
//   * the relayer recovers a note worth `feeIn` in B and gains nothing in A;
//   * the depositor gains exactly `amount` in A and nothing in B;
//   * the pool's protocol fee accrues in A only: the relayer's note is not a
//     protocol fee and must not show up in B's accumulator.
//
// Each pair is one deposit, awaited through its flush. Every assertion is a
// delta over that deposit alone: files run serially and each pair waits for its
// own flush and relayer note before the next pair starts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AssetId, DepositResult } from "@lelantos-org/sdk";

import { env } from "../src/env.js";
import { once, type SdkWallet, setupFile } from "../src/fixture.js";
import {
    accruedFee,
    amt,
    ASSETS,
    awaitOwn,
    type Erc20Helpers,
    EscrowJanitor,
    expectRelayerPaidOnDeposit,
    feeFor,
    type Harness,
    quoteDepositFee,
    relayerFeeWallet,
    scaleFor,
    shieldedBalance,
    SYNC_LIMIT,
    syncedBalance,
    TEST_NSK,
    TEST_TIMEOUT,
    tokenAddressFor,
    withFee,
} from "../src/harness.js";

/**
 * Large enough that the pool's protocol fee is nonzero at every scale: at
 * 500 bps, mWBTC (scale 1) charges 50 base units on it rather than flooring to
 * nothing, which would leave the protocol-fee assertions vacuous for that asset.
 */
const DEPOSIT = amt(1_000n);

type AssetName = keyof typeof ASSETS;

interface Pair {
    name: string;
    deposit: { key: AssetName; id: AssetId };
    fee: { key: AssetName; id: AssetId };
}

/** Every ordered pair of distinct plain assets the stack registers. */
const PAIRS: Pair[] = (Object.entries(ASSETS) as [AssetName, AssetId][]).flatMap(([dKey, dId]) =>
    (Object.entries(ASSETS) as [AssetName, AssetId][])
        .filter(([, fId]) => fId !== dId)
        .map(([fKey, fId]) => ({
            name: `${dKey} deposit, fee in ${fKey}`,
            deposit: { key: dKey, id: dId },
            fee: { key: fKey, id: fId },
        })),
);

/** How many pairs deposit into each asset: every other asset pays for one. */
const DEPOSITS_PER_ASSET = BigInt(Object.keys(ASSETS).length - 1);

describe("deposit paying the relayer in another token, for every pair", () => {
    let h: Harness;
    let alice: SdkWallet;
    let janitor: EscrowJanitor | undefined;
    const tokens = new Map<AssetId, Erc20Helpers>();

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.depositFeePairs,
            // Each asset is deposited once per other asset. Its fee-note pulls
            // are covered by the headroom `fundPayerForAsset` adds on top: a
            // deposit fee is a few circuit units on this stack
            // (`config/oracle/README.md`).
            fund: Object.values(ASSETS).map((asset) => ({
                asset,
                amount: withFee(DEPOSIT * DEPOSITS_PER_ASSET, asset),
            })),
        });
        ({ h } = f);
        ({ alice } = f.w);
        for (const asset of Object.values(ASSETS)) tokens.set(asset, f.token(asset));
        janitor = new EscrowJanitor(h);
    });

    // A pair whose deposit the relayer refuses to flush would otherwise leave
    // its escrow at the head of the flush window for every later file.
    afterAll(() => janitor?.drain());

    function token(asset: AssetId): Erc20Helpers {
        const t = tokens.get(asset);
        if (t === undefined) throw new Error(`no funded token for asset ${asset}`);
        return t;
    }

    /** One token's payer and pool balances, in base units. */
    async function holdings(asset: AssetId): Promise<{ payer: bigint; masp: bigint }> {
        const t = token(asset);
        return { payer: await t.balanceOf(env.payerAddress), masp: await t.balanceOf(env.maspAddress) };
    }

    /**
     * Everything the property reads, for one pair, taken just around its deposit.
     *
     * The relayer and the depositor are synced before the baseline so it holds
     * every note the indexer has already surfaced; the only thing that can move
     * either afterwards is this deposit's flush.
     */
    interface Observed {
        r: DepositResult;
        before: Snapshot;
        after: Snapshot;
        relayerFee: bigint;
    }

    interface Snapshot {
        depositToken: { payer: bigint; masp: bigint };
        feeToken: { payer: bigint; masp: bigint };
        accruedDeposit: bigint;
        accruedFee: bigint;
        relayer: { deposit: bigint; fee: bigint };
        alice: { deposit: bigint; fee: bigint };
    }

    async function snapshot(pair: Pair): Promise<Snapshot> {
        const relayer = await relayerFeeWallet();
        await relayer.sync({ pageSize: SYNC_LIMIT });
        return {
            depositToken: await holdings(pair.deposit.id),
            feeToken: await holdings(pair.fee.id),
            accruedDeposit: await accruedFee(h.provider, tokenAddressFor(pair.deposit.id).address),
            accruedFee: await accruedFee(h.provider, tokenAddressFor(pair.fee.id).address),
            relayer: {
                deposit: await shieldedBalance(relayer, pair.deposit.id),
                fee: await shieldedBalance(relayer, pair.fee.id),
            },
            alice: {
                deposit: await syncedBalance(alice, pair.deposit.id),
                fee: await shieldedBalance(alice, pair.fee.id),
            },
        };
    }

    // One staged deposit per pair, created lazily so each `it` below can run
    // alone with `-t` and pulls in only its own pair's deposit.
    const deposited = new Map<string, () => Promise<Observed>>();
    for (const pair of PAIRS) {
        deposited.set(
            pair.name,
            once(async () => {
                // The relayer charges on this stack, so a fee it prices at zero
                // in B cannot be paid: a zero-value fee leaf carries no fee asset
                // (`FeeAssetMustBeZero`), the flush re-prices it in A, and the
                // deposit is deferred until cancelled. Checked before depositing
                // so that failure names the quote instead of timing out on the
                // flush three minutes later.
                const quoted = await quoteDepositFee(h.relayer, env.chainId, pair.fee.id);
                expect(quoted, `the relayer quotes a payable deposit fee in ${pair.fee.key}`).toBeGreaterThan(0n);

                const before = await snapshot(pair);
                const r = await alice.deposit({ amount: DEPOSIT, asset: pair.deposit.id, feeAsset: pair.fee.id });
                janitor?.track(r.txHash);
                // Read off the escrow before waiting on the flush: a fee leaf
                // escrowed as worthless, or in the wrong asset, is never flushed.
                expect(r.escrow.cancelInputs.feeIn, "the escrowed fee note is worth something").toBeGreaterThan(0n);
                expect(r.escrow.cancelInputs.feeAssetId, "and is bound to the fee asset").toBe(pair.fee.id);
                await awaitOwn(alice, r);
                // Asserts the relayer's note is in B, worth exactly what was
                // escrowed, and that only one of the leaves opens with its keys.
                const relayerFee = await expectRelayerPaidOnDeposit(r, pair.fee.id);
                const after = await snapshot(pair);
                return { r, before, after, relayerFee };
            }),
        );
    }

    function stage(pair: Pair): Promise<Observed> {
        const run = deposited.get(pair.name);
        if (run === undefined) throw new Error(`no staged deposit for ${pair.name}`);
        return run();
    }

    describe.each(PAIRS)("$name", (pair) => {
        const A = pair.deposit.id;
        const B = pair.fee.id;

        it("pulls exactly the principal in the deposit token and the fee note in the fee token", async () => {
            const { r, before, after, relayerFee } = await stage(pair);
            const principal = withFee(DEPOSIT, A);
            // The fee note's base units use the *fee* asset's scale. Across
            // assets of different scales a mix-up here is off by orders of
            // magnitude, which is the drift this file exists to catch.
            const feeBase = relayerFee * scaleFor(B);

            expect(before.depositToken.payer - after.depositToken.payer, "payer debited in A").toBe(principal);
            expect(before.feeToken.payer - after.feeToken.payer, "payer debited in B").toBe(feeBase);
            expect(after.depositToken.masp - before.depositToken.masp, "pool credited in A").toBe(principal);
            expect(after.feeToken.masp - before.feeToken.masp, "pool credited in B").toBe(feeBase);

            // The SDK's own account of the pull: deposit asset first, then the
            // fee asset pulled on its own (`DepositResult.pulled`).
            expect(r.pulled.map((m) => [m.asset, m.baseUnits])).toEqual([
                [A, principal],
                [B, feeBase],
            ]);
        }, TEST_TIMEOUT.DEPOSIT);

        it("binds the fee asset in the escrow and reports each fee in its own asset", async () => {
            const { r, relayerFee } = await stage(pair);
            const inputs = r.escrow.cancelInputs;
            expect(r.escrow.asset, "the escrow is for the deposit asset").toBe(A);
            expect(inputs.publicAssetId).toBe(A);
            expect(inputs.feeAssetId, "the fee leaf is bound to the fee asset").toBe(B);
            expect(inputs.feeIn, "the escrowed fee is the one the relayer recovered").toBe(relayerFee);

            expect(r.fees.protocol, "the pool's fee is charged in the deposit asset").toEqual({
                asset: A,
                amount: expect.anything(),
                baseUnits: feeFor(DEPOSIT, A),
            });
            expect(r.fees.relayer?.asset, "the relayer's fee is reported in the fee asset").toBe(B);
            expect(r.fees.relayer?.amount).toBe(relayerFee);
            expect(r.fees.relayer?.baseUnits).toBe(relayerFee * scaleFor(B));
        }, TEST_TIMEOUT.DEPOSIT);

        it("pays the relayer in the fee asset only, and the depositor in the deposit asset only", async () => {
            const { before, after, relayerFee } = await stage(pair);
            expect(after.relayer.fee - before.relayer.fee, "relayer gained its note in B").toBe(relayerFee);
            expect(after.relayer.deposit - before.relayer.deposit, "relayer gained nothing in A").toBe(0n);
            expect(after.alice.deposit - before.alice.deposit, "depositor credited the full amount in A").toBe(
                DEPOSIT,
            );
            expect(after.alice.fee - before.alice.fee, "depositor holds nothing new in B").toBe(0n);
        }, TEST_TIMEOUT.DEPOSIT);

        it("accrues the protocol fee in the deposit asset, and none in the fee asset", async () => {
            const { before, after } = await stage(pair);
            expect(after.accruedDeposit - before.accruedDeposit, "protocol fee in A").toBe(feeFor(DEPOSIT, A));
            // The relayer's share is a shielded note, not a pool fee: an
            // implementation that booked it into B's accumulator would let the
            // treasury sweep value that belongs to the relayer's note.
            expect(after.accruedFee - before.accruedFee, "no protocol fee in B").toBe(0n);
        }, TEST_TIMEOUT.DEPOSIT);
    });
});
