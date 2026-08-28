import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    accruedFee,
    amt,
    ASSETS,
    awaitOwn,
    circuitFee,
    feeFor,
    type Harness,
    TEST_NSK,
    TEST_TIMEOUT,
    expectRelayerPaid,
    expectRelayerPaidOnDeposit,
    scaleFor,
    withFee,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";

// Shielding native coin. The pool is ERC-20 only, so this never reaches it
// directly: `NativeAdapter` wraps `msg.value`, escrows the WETH under its own
// name via `depositAuthorized`, and unwraps whatever the pool did not pull.
//
// That indirection is the risk surface. `d.payer` must be the adapter, since
// the pool pulls against its Permit2 allowance, while `d.recipient` and `outCm`
// still bind the note to the depositor. A wrong payer reverts
// `AdapterNotPayer`; a wrong note binding escrows real coin to a commitment its
// owner cannot spend, and nothing on-chain catches that. The last case below
// covers it by spending the note afterwards.

const ASSET_WETH = ASSETS.WETH;
const DEPOSIT = amt(15n);
const FEE = feeFor(DEPOSIT, ASSET_WETH);
// What the pool pulls for the principal and the protocol fee. The relayer's fee
// note is pulled on top and is known only once the deposit has landed, so it is
// added per-test from the deposit's own event.
const PRINCIPAL_PLUS_FEE = withFee(DEPOSIT, ASSET_WETH);

const WITHDRAW = amt(4n);
// A withdraw debits the shielded balance by the amount plus its circuit-unit
// fee, which floors to zero at this magnitude.
const WITHDRAW_DEBIT = WITHDRAW + circuitFee(WITHDRAW);

interface Snapshot {
    payerEth: bigint;
    payerWeth: bigint;
    maspWeth: bigint;
    adapterWeth: bigint;
    adapterEth: bigint;
}

// The adapter is deployed only when the stack includes a wrapped-native token.
// Skipping rather than failing makes a partial stack report "not exercised"
// instead of "broken".
describe.skipIf(!env.nativeAdapterAddress)(
    "deposit native ETH (asEth wrap via NativeAdapter)",
    () => {
        let h: Harness;
        let alice: SdkWallet;
        let weth: ethers.Contract;
        let adapter: string;

        async function snap(): Promise<Snapshot> {
            const balanceOf = async (a: string) => (await weth.balanceOf(a)) as bigint;
            return {
                payerEth: await h.provider.getBalance(env.payerAddress),
                payerWeth: await balanceOf(env.payerAddress),
                maspWeth: await balanceOf(env.maspAddress),
                adapterWeth: await balanceOf(adapter),
                adapterEth: await h.provider.getBalance(adapter),
            };
        }

        /// Exact ETH cost of a mined tx, so the payer delta is asserted to the
        /// wei rather than with a `>=` that would hide an over-send.
        async function gasCost(txHash: string): Promise<bigint> {
            const r = await h.provider.getTransactionReceipt(txHash);
            if (!r) throw new Error(`no receipt for ${txHash}`);
            return r.gasUsed * r.gasPrice;
        }

        beforeAll(async () => {
            // Unfunded on purpose: this path exists so the depositor holds no
            // WETH and grants no Permit2 allowance of their own, and the
            // adapter wraps raw coin on their behalf.
            const f = await setupFile({ nsks: TEST_NSK.depositNative });
            ({ h } = f);
            ({ alice } = f.w);
            adapter = env.nativeAdapterAddress!;
            // Read-only handle, so not `setupWeth`, which would wrap ETH.
            weth = new ethers.Contract(
                env.token1,
                ["function balanceOf(address) view returns (uint256)"],
                h.provider,
            );
        });

        /// The deposit every `it` below reads from, memoised so each can run
        /// alone: the adapter-residue and fee checks are assertions about this
        /// deposit rather than steps that follow it.
        const deposited = once(async () => {
            const before = await snap();
            const r = await alice.deposit({ amount: DEPOSIT, asset: ASSET_WETH, asEth: true });
            await awaitOwn(alice, r);
            // The adapter path must build the same two leaves as the ERC-20
            // one, so the relayer has to be able to open the second here too.
            const relayerFee = await expectRelayerPaidOnDeposit(h.provider, r.txHash, ASSET_WETH);
            return { before, relayerFee, after: await snap(), r };
        });

        it("shields raw ETH: payer spends coin, pool gains WETH, note is the depositor's", async () => {
            const { before, relayerFee, after, r } = await deposited();
            // The adapter wraps whatever the pool asks for, so the payer's coin
            // covers the relayer's fee note as well.
            const total = PRINCIPAL_PLUS_FEE + relayerFee * scaleFor(ASSET_WETH);

            // Paid in coin, not token: the adapter did the wrapping. Deltas
            // rather than absolutes, since files share one anvil and one payer
            // account and an earlier file may have left a WETH balance behind.
            expect(after.payerEth - before.payerEth).toBe(-(total + (await gasCost(r.txHash))));
            expect(after.payerWeth - before.payerWeth, "no WETH left the payer").toBe(0n);

            // The pool ends up holding the wrapped deposit plus its fee.
            expect(after.maspWeth - before.maspWeth).toBe(total);

            // Escrowed by the adapter, credited to Alice.
            expect(alice.balance(ASSET_WETH)).toBe(DEPOSIT);
            expect(typeof r.depositId, "pool-assigned id from its DepositEscrowed log").toBe("bigint");
        }, TEST_TIMEOUT.SPEND);

        it("leaves nothing behind on the adapter", async () => {
            // The adapter wraps, escrows and returns the excess within one
            // call, holding funds only for its duration. A residue means the
            // return path kept coin belonging to the sender.
            const { after } = await deposited();
            expect(after.adapterWeth).toBe(0n);
            expect(after.adapterEth).toBe(0n);
        }, TEST_TIMEOUT.SPEND);

        it("accrues the shield fee in WETH, like an ERC-20 deposit", async () => {
            await deposited();
            expect(await accruedFee(h.provider, env.token1)).toBeGreaterThanOrEqual(FEE);
        }, TEST_TIMEOUT.SPEND);

        it("spends the shielded note afterwards, proving the leaf is real", async () => {
            // A deposit counts only if its leaf is spendable: the adapter path
            // must produce the same `cv_dep`-bound leaf as the ERC-20 path, or
            // the note is unspendable and the coin is stranded.
            await deposited();
            const before = alice.balance(ASSET_WETH);
            const r = await alice.withdraw({
                to: env.recipientAddress,
                amount: WITHDRAW,
                asset: ASSET_WETH,
            });
            await awaitOwn(alice, r);
            // The unshield fee leaves the pool and the relayer's fee stays in
            // it as a note. Both come out of alice's balance.
            const fee = await expectRelayerPaid(r, ASSET_WETH);
            expect(before - alice.balance(ASSET_WETH)).toBe(WITHDRAW_DEBIT + fee);
        }, TEST_TIMEOUT.SPEND);
    },
);
