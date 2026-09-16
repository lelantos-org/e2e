// A deposit that pays the relayer in a different token from the one it shields.
//
// The pool pulls two tokens from the payer: the principal plus the protocol fee
// in the deposited asset, and the relayer's note in the fee asset. Nothing in
// the batch circuit ties the two leaves to one asset, so the pool binds the fee
// asset at flush through the escrow digest (`feeAssetId`), and the relayer has
// to price and decrypt a note in an asset the deposit never mentions.
//
// What each case pins, and the drift it catches:
//
//   * both SDK strategies (the Permit2 batch witness and the AllowanceTransfer
//     batch) move exactly the right amount of each token and flush. A strategy
//     that signs or pulls one token only reverts at submit (`InvalidSigner`,
//     `AllowanceExpired`); one that pulls the fee in the deposit token passes a
//     single-token balance check and fails the per-token deltas here.
//   * the relayer ends up holding a spendable note in the fee asset, and nothing
//     in the deposit asset. A note built under the wrong asset generator flushes
//     (the leaf is opaque to the tree) and is worth nothing to the relayer.
//   * the allowance case's window is opened by `wallet.setupDepositAllowance`,
//     not by a raw `permit2.approve`: one `PermitBatch` signature and one
//     `permit` transaction cover both tokens, and the deposit that follows needs
//     no signature of its own.
//   * `wallet.awaitDeposit` reports the escrow's leaf as seen, so the SDK's own
//     wait for a flush is exercised rather than only the suite's.
//   * the depositor's note is in the deposit asset, for the full amount.
//   * a two-token escrow that no relayer flushes refunds each token to the payer
//     through both the raw ABI and the SDK's `cancelDeposit`.
//   * the SDK refuses the combinations the pool would, before signing.

import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AllowanceSetupProgress, isWalletError } from "@lelantos-org/sdk";

import { env } from "../src/env.js";
import { setupFile, once, type SdkWallet } from "../src/fixture.js";
import {
    amt,
    ASSETS,
    awaitOwn,
    buildDirectDeposit,
    cancelDepositAfterDelay,
    type CircuitWallet,
    counter,
    type Erc20Helpers,
    EscrowJanitor,
    escrowOf,
    expectRelayerPaidOnDeposit,
    expectRevert,
    type Harness,
    isEscrowed,
    makeWallet,
    mineIfAnvil,
    newAuxRng,
    quoteDepositFee,
    relayerFeeWallet,
    scaleFor,
    shieldedBalance,
    submitDepositDirect,
    SYNC_LIMIT,
    TEST_NSK,
    TEST_TIMEOUT,
    tokenAddressFor,
    unflushableFee,
    withFee,
    YIELD_ASSETS,
} from "../src/harness.js";
import { POLL } from "../src/testkit/timeouts.js";

const { MDAI: DEPOSIT_ASSET, WETH: FEE_ASSET } = ASSETS;
const { alice: ALICE_NSK } = TEST_NSK.depositFeeAsset;
const DEPOSIT = amt(12n);
/** The two SDK deposits plus the two escrows the cancel case leaves unflushed. */
const DEPOSITS = 4n;
/**
 * The unflushable escrows' note value, in fee-asset circuit units. Any nonzero
 * value takes the two-token path; the relayer never sees it as its own.
 */
const UNFLUSHED_FEE = 3n;

const PERMIT2_ALLOWANCE_ABI = [
    "function approve(address token, address spender, uint160 amount, uint48 expiration)",
    "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
] as const;

/** The two tokens a deposit here pulls, in the order `setupDepositAllowance` is given them. */
const ALLOWANCE_TOKENS = [
    tokenAddressFor(DEPOSIT_ASSET).address,
    tokenAddressFor(FEE_ASSET).address,
];

/**
 * `type(uint160).max`, the cap `setupDepositAllowance` grants by default
 * (`ALLOWANCE_CAP` in `sdk/src/wallet/ops/deposit-allowance.ts`). Permit2 treats
 * it as unlimited and never decrements it, so `expiration` is the only bound.
 */
const ALLOWANCE_CAP = (1n << 160n) - 1n;

/** Permit2 stores `expiration` as a `uint48`; this is the furthest it can reach. */
const PERMIT2_MAX_EXPIRATION = 2 ** 48 - 1;

type Strategy = "witness" | "allowance";

interface Balances {
    payerDeposit: bigint;
    payerFee: bigint;
    maspDeposit: bigint;
    maspFee: bigint;
}

describe("deposit paying the relayer in another asset", () => {
    let h: Harness;
    let alice: SdkWallet;
    let aliceKeys: CircuitWallet;
    let depositToken: Erc20Helpers;
    let feeToken: Erc20Helpers;
    let permit2: ethers.Contract;
    let janitor: EscrowJanitor | undefined;

    beforeAll(async () => {
        const f = await setupFile({
            nsks: TEST_NSK.depositFeeAsset,
            fund: [
                { asset: DEPOSIT_ASSET, amount: withFee(DEPOSIT * DEPOSITS, DEPOSIT_ASSET) },
                // Only relayer notes are paid in WETH; `fundPayerForAsset` adds
                // the fee headroom on top of this.
                { asset: FEE_ASSET, amount: UNFLUSHED_FEE * 2n * scaleFor(FEE_ASSET) },
            ],
        });
        ({ h } = f);
        ({ alice } = f.w);
        aliceKeys = makeWallet(h.P, h.J, ALICE_NSK);
        depositToken = f.token(DEPOSIT_ASSET);
        feeToken = f.token(FEE_ASSET);
        permit2 = new ethers.Contract(env.permit2Address, PERMIT2_ALLOWANCE_ABI, h.payer);
        janitor = new EscrowJanitor(h);
    });

    afterAll(() => janitor?.drain());

    async function balances(): Promise<Balances> {
        return {
            payerDeposit: await depositToken.balanceOf(env.payerAddress),
            payerFee: await feeToken.balanceOf(env.payerAddress),
            maspDeposit: await depositToken.balanceOf(env.maspAddress),
            maspFee: await feeToken.balanceOf(env.maspAddress),
        };
    }

    /**
     * Close the payer's AllowanceTransfer window to the pool on both tokens.
     *
     * A zero expiration means "now" to Permit2, so the window shuts at once. The
     * SDK has no counterpart to `setupDepositAllowance`, so this stays a raw
     * `approve`: it is teardown, not the behaviour under test.
     */
    async function closeAllowance(): Promise<void> {
        for (const token of ALLOWANCE_TOKENS) {
            await (await permit2.approve(token, env.maspAddress, 0n, 0n)).wait();
        }
    }

    /** One token's Permit2 AllowanceTransfer window towards the pool. */
    async function windowOf(token: string): Promise<{ amount: bigint; expiration: bigint; nonce: bigint }> {
        const [amount, expiration, nonce] = (await permit2.allowance(
            env.payerAddress,
            token,
            env.maspAddress,
        )) as [bigint, bigint, bigint];
        return { amount, expiration, nonce };
    }

    /**
     * Open the window through the SDK, and report what it did.
     *
     * The SDK takes the allowance strategy only when every token the deposit
     * pulls is covered, so both are authorised in one call — which is the point
     * of `setupDepositAllowance`: one `PermitBatch` signature and one `permit`
     * transaction for every token, instead of a signature per deposit.
     *
     * Terms are passed rather than defaulted. The SDK's defaults (now + 90 days
     * for the window, now + 30 min for the signature) are computed from the host
     * clock, while Permit2 checks both against `block.timestamp`, and anvil's
     * clock runs ahead of the host's once a cancel delay has been mined through.
     */
    async function openAllowance(): Promise<{ progress: AllowanceSetupProgress[] }> {
        const progress: AllowanceSetupProgress[] = [];
        await alice.setupDepositAllowance({
            assets: [DEPOSIT_ASSET, FEE_ASSET],
            expiration: PERMIT2_MAX_EXPIRATION,
            deadline: BigInt(PERMIT2_MAX_EXPIRATION),
            onProgress: (p) => {
                progress.push(p);
            },
        });
        return { progress };
    }

    /**
     * The relayer's shielded holdings in both assets, as its own wallet reads
     * them, from one sync: the two figures describe the same index state.
     */
    async function relayerBalances(): Promise<{ fee: bigint; deposit: bigint }> {
        const w = await relayerFeeWallet();
        await w.sync({ pageSize: SYNC_LIMIT });
        return {
            fee: await shieldedBalance(w, FEE_ASSET),
            deposit: await shieldedBalance(w, DEPOSIT_ASSET),
        };
    }

    /**
     * One SDK deposit of `DEPOSIT` mDAI paying the relayer in WETH, through
     * `strategy`, and everything the assertions below read about it.
     */
    async function depositVia(strategy: Strategy) {
        // Other files never open an AllowanceTransfer window, but the payer is
        // shared, so the witness case closes it explicitly rather than assume.
        if (strategy === "witness") await closeAllowance();
        const setup = strategy === "allowance" ? await openAllowance() : undefined;
        // Read after the setup and before the deposit: these are the windows the
        // pool's pull is authorised against, so a deposit that reports
        // `strategy: "allowance"` was carried by them and by no signature of its
        // own.
        const windows = await Promise.all(ALLOWANCE_TOKENS.map(windowOf));
        try {
            // A full sync, so the baseline already holds every earlier note the
            // indexer has: files run serially and each awaits its own relayer
            // fees, so nothing but this deposit credits the relayer in between.
            const relayerBefore = await relayerBalances();
            const before = await balances();
            const r = await alice.deposit({
                amount: DEPOSIT,
                asset: DEPOSIT_ASSET,
                feeAsset: FEE_ASSET,
            });
            // The SDK's own wait for the flush: `awaitCommitments` over the one
            // leaf the escrow names (`sdk/src/wallet/surface/api.ts:107-114`).
            // It resolves only once the depositor's leaf is in the tree, i.e.
            // after the relayer flushed the escrow.
            const awaited = await alice.awaitDeposit(r.escrow, {
                pageSize: SYNC_LIMIT,
                pollMs: POLL.COMMITMENT.pollMs,
                timeoutMs: POLL.COMMITMENT.timeoutMs,
            });
            // Kept alongside it: `awaitDeposit` watches the note cache only,
            // while `awaitOwn` also folds the local Merkle tree and cross-checks
            // its root against the pool.
            await awaitOwn(alice, r);
            const after = await balances();
            // Asserts the note is the relayer's, in WETH, for what was escrowed.
            const relayerFee = await expectRelayerPaidOnDeposit(r, FEE_ASSET);
            const relayerAfter = await relayerBalances();
            return { r, awaited, setup, windows, before, after, relayerFee, relayerBefore, relayerAfter };
        } finally {
            if (strategy === "allowance") await closeAllowance();
        }
    }

    // Serial: the allowance case must not open its window while the witness
    // case is choosing a strategy. Settled rather than succeeded: the allowance
    // deposit does not use the witness one, and a witness failure is reported
    // by the witness cases, which rethrow the memoised rejection.
    const viaWitness = once(() => depositVia("witness"));
    const viaAllowance = once(async () => {
        await viaWitness().catch(() => undefined);
        return depositVia("allowance");
    });
    // The allowance variant runs the witness deposit first when run alone.
    const BUDGET: Record<Strategy, number> = {
        witness: TEST_TIMEOUT.DEPOSIT,
        allowance: TEST_TIMEOUT.SEQUENCE,
    };
    const VIA: Record<Strategy, typeof viaWitness> = { witness: viaWitness, allowance: viaAllowance };

    describe.each(["witness", "allowance"] as const)("via the %s strategy", (strategy) => {
        it("pulls principal in the deposit token and the relayer fee in the fee token", async () => {
            const { r, before, after, relayerFee } = await VIA[strategy]();
            expect(r.strategy).toBe(strategy);
            expect(relayerFee, "relayer must charge, or the fee asset is never exercised").toBeGreaterThan(0n);

            const principal = withFee(DEPOSIT, DEPOSIT_ASSET);
            const fee = relayerFee * scaleFor(FEE_ASSET);
            expect(before.payerDeposit - after.payerDeposit, "mDAI debited").toBe(principal);
            expect(before.payerFee - after.payerFee, "WETH debited").toBe(fee);
            expect(after.maspDeposit - before.maspDeposit, "pool mDAI").toBe(principal);
            expect(after.maspFee - before.maspFee, "pool WETH").toBe(fee);
        }, BUDGET[strategy]);

        it("pulls under the Permit2 window state its strategy implies", async () => {
            const { r, windows } = await VIA[strategy]();
            expect(r.strategy).toBe(strategy);
            // The SDK picks the allowance strategy only when every token the
            // deposit pulls is covered by an open window, so the window state
            // read between the setup and the deposit is what carried the pull:
            // open at the cap for the allowance case, at zero for the witness
            // one, which therefore had to sign a per-deposit Permit2 witness.
            //
            // The cap alone, not the expiry: Permit2 stores a zero `expiration`
            // as `block.timestamp` rather than as zero
            // (`Allowance.updateAmountAndExpiration`), so a shut window
            // reads back with whatever the closing block's timestamp was. The
            // expiry the setup asked for is asserted where it was asked for.
            const amount = strategy === "allowance" ? ALLOWANCE_CAP : 0n;
            expect(windows.map((w) => w.amount), "window cap per token").toEqual([amount, amount]);
        }, BUDGET[strategy]);

        it("flushes the escrow", async () => {
            const { r } = await VIA[strategy]();
            expect(r.escrow.depositId, "the id the pool's DepositEscrowed assigned")
                .toBe((await escrowOf(h.provider, r.txHash)).depositId);
            expect(await isEscrowed(h.provider, r.escrow.depositId), "escrow slot cleared by the flush").toBe(false);
        }, BUDGET[strategy]);

        it("awaitDeposit reports the escrowed commitment as seen", async () => {
            const { r, awaited } = await VIA[strategy]();
            // The escrow names one leaf, the depositor's note, and it is the one
            // the deposit result reports as this wallet's.
            expect(r.ownCommitments).toHaveLength(1);
            expect(r.escrow.commitment.toLowerCase()).toBe(r.ownCommitments[0].toLowerCase());
            // "seen" is the only status that means the flush landed and the
            // indexer surfaced it: `timeout` and `aborted` both resolve rather
            // than throw (`notes/note-cache.ts:48,62-64`), so a test that ignored
            // this would pass against a relayer that never flushed.
            expect(awaited.missing, "the flushed leaf reached the note cache").toEqual([]);
            expect(awaited.status).toBe("seen");
        }, BUDGET[strategy]);

        it("credits the relayer's shielded balance in the fee asset only", async () => {
            const { relayerFee, relayerBefore, relayerAfter } = await VIA[strategy]();
            expect(relayerAfter.fee, "relayer credited the escrowed fee, in WETH").toBe(relayerBefore.fee + relayerFee);
            expect(relayerAfter.deposit, "no relayer note in the deposit asset").toBe(relayerBefore.deposit);
        }, BUDGET[strategy]);

        it("gives the depositor one note in the deposit asset, for the full amount", async () => {
            const { r } = await VIA[strategy]();
            expect(r.ownCommitments).toHaveLength(1);
            const cm = r.ownCommitments[0].toLowerCase();
            const note = (await alice.notes()).find((n) => n.cm.toLowerCase() === cm);
            expect(note, "depositor note recovered").toBeDefined();
            expect(note!.asset).toBe(DEPOSIT_ASSET);
            expect(note!.value).toBe(DEPOSIT);
            // The fee note is the relayer's; the depositor holds no WETH.
            expect(await shieldedBalance(alice, FEE_ASSET)).toBe(0n);
        }, BUDGET[strategy]);
    });

    it("setupDepositAllowance authorises both tokens in one signature and one transaction", async () => {
        const { setup, windows } = await viaAllowance();
        expect(alice.capabilities.depositAllowance, "the chain adapter can sign a PermitBatch").toBe(true);
        if (setup === undefined) throw new Error("the allowance case is the one that runs the setup");

        // Both tokens got the window the call asked for, in one `permit`.
        const expiration = BigInt(PERMIT2_MAX_EXPIRATION);
        expect(windows.map((w) => w.amount), "unlimited cap per token")
            .toEqual([ALLOWANCE_CAP, ALLOWANCE_CAP]);
        expect(windows.map((w) => w.expiration), "the expiry the call asked for")
            .toEqual([expiration, expiration]);

        // The whole report the call makes: it resolves to `void`, so `onProgress`
        // is the only thing it returns. No `approving` step, because the fixture
        // already approves Permit2 for `MaxUint256` on every funded token
        // (`approveSpender` in `src/scenario.ts`), which is above the cap the
        // setup asks for, so pass 1 has nothing to send. Then exactly one
        // signature and one transaction, whatever the number of tokens.
        expect(setup.progress.map((p) => `${p.step}:${p.status}`)).toEqual([
            "signing:wallet",
            "permitting:wallet",
            "permitting:confirming",
        ]);

        // `confirming` is emitted with the hash of a transaction that was sent,
        // so it names a real `permit` call on Permit2 rather than a placeholder.
        const txHash = setup.progress.at(-1)?.txHash;
        if (txHash === undefined) throw new Error("the permitting step reported no transaction hash");
        const receipt = await h.provider.getTransactionReceipt(txHash);
        if (receipt === null) throw new Error(`no receipt for the permit transaction ${txHash}`);
        expect(receipt.status, "permit mined successfully").toBe(1);
        expect(receipt.to?.toLowerCase(), "sent to Permit2").toBe(env.permit2Address.toLowerCase());
    }, TEST_TIMEOUT.SEQUENCE);

    it("refunds each token of an unflushed two-token escrow, via the raw ABI and the SDK", async () => {
        // After the SDK deposits, so escrows no relayer flushes are never
        // pending while those wait on a flush. Settled rather than succeeded:
        // nothing here reads them, and their own cases report a failure.
        await viaAllowance().catch(() => undefined);
        // A relayer that charges nothing would flush anything, including these.
        expect(await quoteDepositFee(h.relayer, env.chainId, FEE_ASSET)).toBeGreaterThan(0n);

        const rng = counter(0xfa_ca9_0001n);
        const auxRng = newAuxRng(0xfa_add_0001n);
        const principal = withFee(DEPOSIT, DEPOSIT_ASSET);
        const fee = UNFLUSHED_FEE * scaleFor(FEE_ASSET);

        // Addressed to the depositor rather than to the relayer, so the relayer
        // cannot open it and leaves the deposit escrowed.
        // Handed to the janitor as soon as it lands, so a failed assertion
        // below cannot strand it.
        const submit = async () => {
            const built = buildDirectDeposit(h, {
                amount: DEPOSIT,
                asset: DEPOSIT_ASSET,
                recipient: aliceKeys.recipient,
                rngs: { rng, auxRng },
                fee: (rngs) => unflushableFee(aliceKeys.recipient, rngs, {
                    value: UNFLUSHED_FEE,
                    asset: FEE_ASSET,
                }),
            });
            expect(built.deposit.feeAssetId).toBe(FEE_ASSET);
            // Signs `maxTotal = principal` in mDAI and `maxFee = fee` in WETH.
            const r = await submitDepositDirect(h, built);
            janitor?.track(r.txHash);
            return r;
        };

        const start = await balances();
        const raw = await submit();
        const viaSdk = await submit();
        const escrowed = await balances();
        expect(start.payerDeposit - escrowed.payerDeposit).toBe(2n * principal);
        expect(start.payerFee - escrowed.payerFee).toBe(2n * fee);

        // Raw ABI: mines only to `raw`'s cancel block.
        const c1 = await cancelDepositAfterDelay(h, raw.txHash);
        expect(c1.refunded, "principal + shield fee, in mDAI").toBe(principal);
        expect(c1.feeAssetId).toBe(FEE_ASSET);
        expect(c1.feeRefunded, "relayer note, in WETH").toBe(fee);
        expect(await isEscrowed(h.provider, raw.depositId)).toBe(false);

        // SDK: the same preimage, encoded by the wallet's chain adapter. The
        // escrow is the one a deposit result would carry, and its
        // `cancelInputs` are used as-is. `viaSdk` landed after `raw`, so its
        // cancel block can still be ahead of the tip; the SDK sends without
        // waiting for it.
        const escrow = await escrowOf(h.provider, viaSdk.txHash);
        const behind = escrow.cancellableAtBlock - (await h.provider.getBlockNumber());
        if (behind > 0) await mineIfAnvil(h.provider, behind);
        const c2 = await alice.cancelDeposit(escrow);
        expect(c2.native).toBe(false);
        expect(c2.refunded.asset).toBe(DEPOSIT_ASSET);
        expect(c2.refunded.baseUnits, "principal + shield fee, in mDAI").toBe(principal);
        expect(c2.feeRefunded?.asset).toBe(FEE_ASSET);
        expect(c2.feeRefunded?.baseUnits, "relayer note, in WETH").toBe(fee);
        expect(await isEscrowed(h.provider, viaSdk.depositId)).toBe(false);

        // Every wei of both tokens is back with the payer.
        const end = await balances();
        expect(end.payerDeposit).toBe(start.payerDeposit);
        expect(end.payerFee).toBe(start.payerFee);
        expect(end.maspDeposit).toBe(start.maspDeposit);
        expect(end.maspFee).toBe(start.maspFee);
    }, TEST_TIMEOUT.SEQUENCE);

    it("rejects a native deposit paying the relayer in another asset, before signing", async () => {
        const nonce = await h.provider.getTransactionCount(env.payerAddress, "pending");
        const err = await expectRevert(
            alice.deposit({ amount: DEPOSIT, asset: FEE_ASSET, native: true, feeAsset: DEPOSIT_ASSET }),
            { code: "INVALID_ARGUMENT" },
        );
        expect(isWalletError(err, "INVALID_ARGUMENT") && err.argument).toBe("feeAsset");
        expect(await h.provider.getTransactionCount(env.payerAddress, "pending"), "nothing sent").toBe(nonce);
    }, TEST_TIMEOUT.SPEND);

    it.skipIf(!process.env.YIELD_ASSET_IDS)(
        "rejects a yield-bearing fee asset other than the deposit asset",
        async () => {
            const err = await expectRevert(
                alice.deposit({ amount: DEPOSIT, asset: DEPOSIT_ASSET, feeAsset: YIELD_ASSETS.WETH }),
                { code: "INVALID_ARGUMENT" },
            );
            expect(isWalletError(err, "INVALID_ARGUMENT") && err.argument).toBe("feeAsset");
        },
        TEST_TIMEOUT.SPEND,
    );
});
