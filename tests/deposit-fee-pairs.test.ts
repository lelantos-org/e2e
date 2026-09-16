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
import { type FileFixture, once, setupFile } from "../src/fixture.js";
import {
    accruedFee,
    amt,
    ASSETS,
    awaitOwn,
    EscrowJanitor,
    expectRelayerPaidOnDeposit,
    feeFor,
    quoteDepositFee,
    relayerFeeWallet,
    scaleFor,
    shieldedBalance,
    SYNC_LIMIT,
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

const ASSET_ENTRIES = Object.entries(ASSETS) as [AssetName, AssetId][];

interface Pair {
    name: string;
    deposit: { key: AssetName; id: AssetId };
    fee: { key: AssetName; id: AssetId };
}

/** Every ordered pair of distinct plain assets the stack registers. */
const PAIRS: Pair[] = ASSET_ENTRIES.flatMap(([dKey, dId]) =>
    ASSET_ENTRIES.filter(([, fId]) => fId !== dId).map(([fKey, fId]) => ({
        name: `${dKey} deposit, fee in ${fKey}`,
        deposit: { key: dKey, id: dId },
        fee: { key: fKey, id: fId },
    })),
);

/** How many pairs deposit into each asset: every other asset pays for one. */
const DEPOSITS_PER_ASSET = BigInt(ASSET_ENTRIES.length - 1);

/**
 * Everything the property reads about one asset, for the deposit's two roles
 * (the asset deposited, and the asset paying the relayer).
 *
 * `payer` and `masp` are ERC-20 balances in base units; `accrued` is the pool's
 * protocol-fee accumulator in base units; `relayer` and `depositor` are shielded
 * balances in circuit units.
 */
interface Holdings {
    payer: bigint;
    masp: bigint;
    accrued: bigint;
    relayer: bigint;
    depositor: bigint;
}

interface Snapshot {
    deposit: Holdings;
    fee: Holdings;
}

interface Observed {
    r: DepositResult;
    /** `after - before` for every field: negative where value left. */
    change: Snapshot;
    relayerFee: bigint;
}

function change(before: Snapshot, after: Snapshot): Snapshot {
    const diff = (b: Holdings, a: Holdings): Holdings => ({
        payer: a.payer - b.payer,
        masp: a.masp - b.masp,
        accrued: a.accrued - b.accrued,
        relayer: a.relayer - b.relayer,
        depositor: a.depositor - b.depositor,
    });
    return { deposit: diff(before.deposit, after.deposit), fee: diff(before.fee, after.fee) };
}

describe("deposit paying the relayer in another token, for every pair", () => {
    let f: FileFixture<"alice">;
    let janitor: EscrowJanitor | undefined;

    beforeAll(async () => {
        f = await setupFile({
            nsks: TEST_NSK.depositFeePairs,
            // Each asset is deposited once per other asset. Its fee-note pulls
            // are covered by the headroom `fundPayerForAsset` adds on top: a
            // deposit fee is a few circuit units on this stack
            // (`config/oracle/README.md`).
            fund: ASSET_ENTRIES.map(([, asset]) => ({
                asset,
                amount: withFee(DEPOSIT * DEPOSITS_PER_ASSET, asset),
            })),
        });
        janitor = new EscrowJanitor(f.h);
    });

    // A pair whose deposit the relayer refuses to flush would otherwise leave
    // its escrow at the head of the flush window for every later file.
    afterAll(() => janitor?.drain());

    type RelayerWallet = Awaited<ReturnType<typeof relayerFeeWallet>>;

    /** One asset's holdings, read from wallets the caller has just synced. */
    async function holdings(asset: AssetId, relayer: RelayerWallet): Promise<Holdings> {
        const token = f.token(asset);
        return {
            payer: await token.balanceOf(env.payerAddress),
            masp: await token.balanceOf(env.maspAddress),
            accrued: await accruedFee(f.h.provider, tokenAddressFor(asset).address),
            relayer: await shieldedBalance(relayer, asset),
            depositor: await shieldedBalance(f.w.alice, asset),
        };
    }

    /**
     * Both assets' holdings. The relayer and the depositor are synced first, so
     * the baseline holds every note the indexer has already surfaced and the
     * only thing that can move either afterwards is this deposit's flush.
     */
    async function snapshot(pair: Pair): Promise<Snapshot> {
        const relayer = await relayerFeeWallet();
        await relayer.sync({ scope: "notes", pageSize: SYNC_LIMIT });
        await f.w.alice.sync({ scope: "notes", pageSize: SYNC_LIMIT });
        return { deposit: await holdings(pair.deposit.id, relayer), fee: await holdings(pair.fee.id, relayer) };
    }

    async function depositPair(pair: Pair): Promise<Observed> {
        // The relayer charges on this stack, so a fee it prices at zero in B
        // cannot be paid: a zero-value fee leaf carries no fee asset
        // (`FeeAssetMustBeZero`), the flush re-prices it in A, and the deposit
        // is deferred until cancelled. Checked before depositing so that failure
        // names the quote instead of timing out on the flush minutes later.
        const quoted = await quoteDepositFee(f.h.relayer, env.chainId, pair.fee.id);
        expect(quoted, `the relayer quotes a payable deposit fee in ${pair.fee.key}`).toBeGreaterThan(0n);

        const before = await snapshot(pair);
        const r = await f.w.alice.deposit({ amount: DEPOSIT, asset: pair.deposit.id, feeAsset: pair.fee.id });
        janitor?.track(r.txHash);
        // Read off the escrow before waiting on the flush: a fee leaf escrowed
        // as worthless, or in the wrong asset, is never flushed.
        expect(r.escrow.cancelInputs.feeIn, "the escrowed fee note is worth something").toBeGreaterThan(0n);
        expect(r.escrow.cancelInputs.feeAssetId, "and is bound to the fee asset").toBe(pair.fee.id);
        await awaitOwn(f.w.alice, r);
        // Asserts the relayer's note is in B, worth exactly what was escrowed,
        // and that only one of the leaves opens with its keys.
        const relayerFee = await expectRelayerPaidOnDeposit(r, pair.fee.id);
        return { r, change: change(before, await snapshot(pair)), relayerFee };
    }

    describe.each(PAIRS)("$name", (pair) => {
        const A = pair.deposit.id;
        const B = pair.fee.id;
        // Staged once per pair, so each `it` below can run alone with `-t` and
        // pulls in only its own pair's deposit.
        const deposited = once(() => depositPair(pair));

        it("pulls exactly the principal in the deposit token and the fee note in the fee token", async () => {
            const { r, change: d, relayerFee } = await deposited();
            const principal = withFee(DEPOSIT, A);
            // The fee note's base units use the *fee* asset's scale. Across
            // assets of different scales a mix-up here is off by orders of
            // magnitude, which is the drift this file exists to catch.
            const feeBase = relayerFee * scaleFor(B);

            expect({ payer: d.deposit.payer, masp: d.deposit.masp }, "deposit token").toEqual({
                payer: -principal,
                masp: principal,
            });
            expect({ payer: d.fee.payer, masp: d.fee.masp }, "fee token").toEqual({
                payer: -feeBase,
                masp: feeBase,
            });
            // The SDK's own account of the pull: deposit asset first, then the
            // fee asset pulled on its own (`DepositResult.pulled`).
            expect(r.pulled.map((m) => [m.asset, m.baseUnits])).toEqual([
                [A, principal],
                [B, feeBase],
            ]);
        }, TEST_TIMEOUT.DEPOSIT);

        it("binds the fee asset in the escrow and reports each fee in its own asset", async () => {
            const { r, relayerFee } = await deposited();
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
            expect(r.fees.relayer, "the relayer's fee is reported in the fee asset").toEqual({
                asset: B,
                amount: relayerFee,
                baseUnits: relayerFee * scaleFor(B),
            });
        }, TEST_TIMEOUT.DEPOSIT);

        it("pays the relayer in the fee asset only, and the depositor in the deposit asset only", async () => {
            const { change: d, relayerFee } = await deposited();
            expect({ relayer: d.deposit.relayer, depositor: d.deposit.depositor }, "deposit asset").toEqual({
                relayer: 0n,
                depositor: DEPOSIT,
            });
            expect({ relayer: d.fee.relayer, depositor: d.fee.depositor }, "fee asset").toEqual({
                relayer: relayerFee,
                depositor: 0n,
            });
        }, TEST_TIMEOUT.DEPOSIT);

        it("accrues the protocol fee in the deposit asset, and none in the fee asset", async () => {
            const { change: d } = await deposited();
            expect(d.deposit.accrued, "protocol fee in A").toBe(feeFor(DEPOSIT, A));
            // The relayer's share is a shielded note, not a pool fee: an
            // implementation that booked it into B's accumulator would let the
            // treasury sweep value that belongs to the relayer's note.
            expect(d.fee.accrued, "no protocol fee in B").toBe(0n);
        }, TEST_TIMEOUT.DEPOSIT);
    });
});
