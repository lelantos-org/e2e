import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env.js";
import {
    amt,
    ASSETS,
    awaitOwn,
    depositTotal,
    escrowOf,
    feeFor,
    type Harness,
    TEST_NSK,
    TEST_TIMEOUT,
    expectRelayerPaid,
    shieldedBalance,
    trackedAddrs,
} from "../src/harness.js";
import { once, setupFile, type SdkWallet } from "../src/fixture.js";
import { depositStep } from "../src/testkit/steps.js";

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

// `gross` is the whole debit against the shielded balance: the protocol fee is
// skimmed out of it rather than charged on top.
const WITHDRAW = amt(4n);

// The adapter is deployed only when the stack includes a wrapped-native token.
// Skipping rather than failing makes a partial stack report "not exercised"
// instead of "broken".
describe.skipIf(!env.nativeAdapterAddress)(
    "deposit native ETH (native wrap via NativeAdapter)",
    () => {
        let h: Harness;
        let alice: SdkWallet;

        beforeAll(async () => {
            // Unfunded on purpose: this path exists so the depositor holds no
            // WETH and grants no Permit2 allowance of their own, and the
            // adapter wraps raw coin on their behalf.
            const f = await setupFile({ nsks: TEST_NSK.depositNative });
            ({ h } = f);
            ({ alice } = f.w);
        });

        /// Exact ETH cost of a mined tx, so the payer delta is asserted to the
        /// wei rather than with a `>=` that would hide an over-send.
        async function gasCost(txHash: string): Promise<bigint> {
            const r = await h.provider.getTransactionReceipt(txHash);
            if (!r) throw new Error(`no receipt for ${txHash}`);
            return r.gasUsed * r.gasPrice;
        }

        /// The deposit every `it` below reads from, memoised so each can run
        /// alone: the adapter-residue and fee checks are assertions about this
        /// deposit rather than steps that follow it.
        ///
        /// The adapter path must build the same two leaves as the ERC-20 one,
        /// so the step's relayer-fee check has to open the second here too.
        const deposited = once(() => {
            const adapter = env.nativeAdapterAddress;
            // Unreachable under the `skipIf`; narrows the address.
            if (!adapter) throw new Error("NATIVE_ADAPTER_ADDRESS unset");
            return depositStep(
                h,
                alice,
                { amount: DEPOSIT, asset: ASSET_WETH, native: true },
                {
                    accounts: { ...trackedAddrs(), adapter },
                    eth: { payer: env.payerAddress, adapter },
                },
            );
        });

        it("shields raw ETH: payer spends coin, pool gains WETH, note is the depositor's", async () => {
            const { r, erc20, eth, fee } = await deposited();
            // The adapter wraps whatever the pool asks for, so the payer's coin
            // covers the relayer's fee note as well.
            const total = depositTotal(DEPOSIT, fee, ASSET_WETH);

            // Paid in coin, not token: the adapter did the wrapping.
            expect(eth.payer).toBe(-(total + (await gasCost(r.txHash))));
            expect(erc20.payer, "no WETH left the payer").toBe(0n);

            // The pool ends up holding the wrapped deposit plus its fee.
            expect(erc20.masp).toBe(total);

            // Escrowed by the adapter, credited to Alice.
            expect(await shieldedBalance(alice, ASSET_WETH)).toBe(DEPOSIT);
            expect(r.escrow.depositId, "the id the pool's DepositEscrowed log assigned").toBe(
                (await escrowOf(h.provider, r.txHash)).depositId,
            );
        }, TEST_TIMEOUT.DEPOSIT);

        it("leaves nothing behind on the adapter", async () => {
            // The adapter wraps, escrows and returns the excess within one
            // call, holding funds only for its duration. A residue means the
            // return path kept coin belonging to the sender. Deltas, so a
            // balance another file left on it neither fails nor masks this one.
            const { erc20, eth } = await deposited();
            expect(erc20.adapter).toBe(0n);
            expect(eth.adapter).toBe(0n);
        }, TEST_TIMEOUT.DEPOSIT);

        it("accrues the shield fee in WETH, like an ERC-20 deposit", async () => {
            const { accrued } = await deposited();
            expect(accrued).toBe(FEE);
        }, TEST_TIMEOUT.DEPOSIT);

        it("spends the shielded note afterwards, proving the leaf is real", async () => {
            // A deposit counts only if its leaf is spendable: the adapter path
            // must produce the same `cv_dep`-bound leaf as the ERC-20 path, or
            // the note is unspendable and the coin is stranded.
            await deposited();
            const before = await shieldedBalance(alice, ASSET_WETH);
            const r = await alice.withdraw({
                recipient: env.recipientAddress,
                gross: WITHDRAW,
                asset: ASSET_WETH,
            });
            await awaitOwn(alice, r);
            // The unshield fee leaves the pool and the relayer's fee stays in
            // it as a note. Both come out of alice's balance.
            const fee = await expectRelayerPaid(r, ASSET_WETH);
            expect(before - (await shieldedBalance(alice, ASSET_WETH))).toBe(WITHDRAW + fee);
        }, TEST_TIMEOUT.SEQUENCE);
    },
);
