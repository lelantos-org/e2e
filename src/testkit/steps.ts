// One wallet deposit or withdrawal, measured: the public balances it moved, the
// fee the relayer collected, and what the pool accrued for it.
//
// The round-trip files all assert the same three things about a step, so the
// snapshots are taken here, around exactly the work under test. Every figure is
// a delta: files share one anvil, one payer account and one pool, so absolutes
// carry whatever ran earlier.
//
// Not re-exported from `harness.ts`, which this module imports. Tests import it
// directly from `../src/testkit/steps.js`.

import { ethers } from "ethers";

import type {
    AssetId,
    DepositOptions,
    DepositResult,
    WalletApi,
    WithdrawOptions,
    WithdrawResult,
} from "@lelantos-org/sdk";

import {
    accruedFee,
    awaitOwn,
    type Erc20Helpers,
    expectRelayerPaid,
    expectRelayerPaidOnDeposit,
    type Harness,
    MOCK_ERC20_ABI,
    snapshotBalances,
    tokenAddressFor,
    trackedAddrs,
} from "../harness.js";

/** Balance change per named account. */
export type Deltas = Record<string, bigint>;

export interface Step<R> {
    r: R;
    /** ERC-20 balance change of each account in `accounts`, in base units. */
    erc20: Deltas;
    /** Native-coin balance change of each account in `eth`, in wei. */
    eth: Deltas;
    /** The relayer's fee, confirmed recovered by the relayer. Circuit units. */
    fee: bigint;
    /** Exact change in the pool's `accruedFee` for the asset's token. Base units. */
    accrued: bigint;
}

export interface StepOpts {
    /** Accounts whose ERC-20 balance is tracked. Default `trackedAddrs()`. */
    accounts?: Record<string, string>;
    /** Accounts whose native-coin balance is tracked. Default none. */
    eth?: Record<string, string>;
}

/** Deposit, wait for the note, confirm the relayer's fee note. */
export function depositStep(
    h: Harness,
    w: WalletApi,
    // No `feeAsset`: the step confirms the relayer's note in the deposit's own
    // asset, and a deposit paying in another one needs its own assertion.
    args: Omit<DepositOptions, "feeAsset"> & { asset: AssetId },
    opts: StepOpts = {},
): Promise<Step<DepositResult>> {
    return measured(h, w, args.asset, opts, () => w.deposit(args), (r) =>
        expectRelayerPaidOnDeposit(r, args.asset),
    );
}

/** Withdraw, wait for the change, confirm the relayer's fee note. */
export function withdrawStep(
    h: Harness,
    w: WalletApi,
    args: WithdrawOptions & { asset: AssetId },
    opts: StepOpts = {},
): Promise<Step<WithdrawResult>> {
    return measured(h, w, args.asset, opts, () => w.withdraw(args), (r) =>
        expectRelayerPaid(r, args.asset),
    );
}

async function measured<R extends DepositResult | WithdrawResult>(
    h: Harness,
    w: WalletApi,
    asset: AssetId,
    opts: StepOpts,
    send: () => Promise<R>,
    paid: (r: R) => Promise<bigint>,
): Promise<Step<R>> {
    const tokenAddr = tokenAddressFor(asset).address;
    // Read-only, so an unfunded asset (a native deposit's WETH) is measurable
    // too.
    const token = readOnlyErc20(h, tokenAddr);
    const accounts = opts.accounts ?? trackedAddrs();
    const ethAccounts = opts.eth ?? {};
    const snap = async () => ({
        erc20: await snapshotBalances(token, accounts),
        eth: await ethBalances(h, ethAccounts),
        accrued: await accruedFee(h.provider, tokenAddr),
    });

    const before = await snap();
    const r = await send();
    await awaitOwn(w, r);
    // After `awaitOwn`: a deposit's fee leaf reaches the tree at flush, which
    // is also when its protocol fee accrues.
    const fee = await paid(r);
    const after = await snap();
    return {
        r,
        erc20: diff(before.erc20, after.erc20),
        eth: diff(before.eth, after.eth),
        fee,
        accrued: after.accrued - before.accrued,
    };
}

function readOnlyErc20(h: Harness, address: string): Erc20Helpers {
    const contract = new ethers.Contract(address, MOCK_ERC20_ABI, h.provider);
    return { contract, balanceOf: async (a) => (await contract.balanceOf(a)) as bigint };
}

async function ethBalances(h: Harness, accounts: Record<string, string>): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {};
    for (const [name, addr] of Object.entries(accounts)) out[name] = await h.provider.getBalance(addr);
    return out;
}

function diff(before: Record<string, bigint>, after: Record<string, bigint>): Deltas {
    return Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k]]));
}
