// Circuit-level wallet material, ERC-20 setup, and the balance/commitment
// helpers the assertions in `tests/` are written against.

import { expect } from "vitest";

import { ethers } from "ethers";

import type { OutputRecipient } from "@lelantos-org/sdk/bundle";
import type { Field, Jubjub, Poseidon } from "@lelantos-org/sdk/crypto";
import { FmdClient, type FmdNoteOut } from "@lelantos-org/sdk/fmd-server";
import { buildSpendingKey, type SpendingKey } from "@lelantos-org/sdk/keys";

import { MASP_ABI, MOCK_ERC20_ABI, MOCK_WETH9_ABI } from "./protocol/abi.js";
import { LIST_LIMIT, TIMEOUT } from "./testkit/timeouts.js";
import { env } from "./env.js";
import { cmToHex, pollUntil } from "./utils.js";

/** The raw key bundle the direct `buildDeposit` path takes. */
export interface CircuitWallet {
    keys: SpendingKey;
    recipient: OutputRecipient;
}

export function makeWallet(P: Poseidon, J: Jubjub, nsk: Field): CircuitWallet {
    const keys = buildSpendingKey(P, J, nsk);
    return {
        keys,
        // An `OutputRecipient` carries the public clue key `ck`, never the root
        // detection secret `dk`; expanding `ck` yields flag-key points only.
        recipient: { pk_d: keys.pk_d, pk: keys.pk, ck: keys.ck },
    };
}

export function rngForOutput(rng: () => Field): { esk: Field; fmdR: Field } {
    return { esk: rng(), fmdR: rng() };
}

export interface Erc20Helpers {
    contract: ethers.Contract;
    balanceOf(addr: string): Promise<bigint>;
}

async function approveSpender(c: ethers.Contract, spender: string): Promise<void> {
    await (await c.approve(spender, ethers.MaxUint256)).wait();
}

function erc20Helpers(c: ethers.Contract): Erc20Helpers {
    return {
        contract: c,
        balanceOf: async (addr) => (await c.balanceOf(addr)) as bigint,
    };
}

export async function setupErc20(
    payer: ethers.Signer,
    tokenAddr: string,
    spender: string,
    initialMint: bigint,
): Promise<Erc20Helpers> {
    const c = new ethers.Contract(tokenAddr, MOCK_ERC20_ABI, payer);
    await (await c.mint(await payer.getAddress(), initialMint)).wait();
    await approveSpender(c, spender);
    return erc20Helpers(c);
}

export async function setupWeth(
    payer: ethers.Signer,
    wethAddr: string,
    spender: string,
    amount: bigint,
): Promise<Erc20Helpers> {
    const c = new ethers.Contract(wethAddr, MOCK_WETH9_ABI, payer);
    await (await c.deposit({ value: amount })).wait();
    await approveSpender(c, spender);
    return erc20Helpers(c);
}

// Asks for `LIST_LIMIT`, the server's maximum, so a freshly indexed cm is not
// buried behind older pages.
export async function waitForCm(fmd: FmdClient, cm: Field): Promise<FmdNoteOut> {
    const cmHex = cmToHex(cm);
    return pollUntil(async () => {
        const rows = await fmd.listNotes({ limit: LIST_LIMIT });
        return rows.find((n) => n.cm === cm);
    }, { label: `fmd notes(${cmHex.slice(0, 12)})`, timeoutMs: TIMEOUT.POLL_DEFAULT_MS });
}

/**
 * The three accounts every ERC-20 balance assertion in the suite tracks: where
 * the funds come from, where they are held while shielded, and where they land
 * on the way out. Read lazily so `env` is not touched at import time.
 */
export const trackedAddrs = (): Record<string, string> => ({
    payer: env.payerAddress,
    masp: env.maspAddress,
    recipient: env.recipientAddress,
});

export async function snapshotBalances(
    token: Erc20Helpers,
    addrs: Record<string, string> = trackedAddrs(),
): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {};
    for (const [name, addr] of Object.entries(addrs)) {
        out[name] = await token.balanceOf(addr);
    }
    return out;
}

let _feeView: ethers.Contract | undefined;

/**
 * Fees the pool has accrued for `tokenAddr`, in base units.
 *
 * Assert with `toBeGreaterThanOrEqual`: the counter is cumulative across the
 * run and every test file shares one MASP, so any file depositing or
 * withdrawing the same asset raises it. An exact assertion would encode the
 * file ordering into the test.
 */
export async function accruedFee(
    provider: ethers.Provider,
    tokenAddr: string,
): Promise<bigint> {
    _feeView ??= new ethers.Contract(env.maspAddress, MASP_ABI, provider);
    return (await _feeView.accruedFee(tokenAddr)) as bigint;
}

/**
 * Commitments the counterparty is expected to scan.
 *
 * "Not the sender's" does not define them: a fee-paying spend has a third kind
 * of output, the note addressed to the relayer, which is non-zero and not the
 * sender's, so a receiver-side wait built by elimination blocks forever on a
 * note only the relayer can decrypt.
 *
 * Slot order does not identify the payee either, because the SDK shuffles
 * output slots. The result therefore carries `recipientCommitment` explicitly,
 * and elimination is the fallback only for kinds with no single payee.
 *
 * Sender-side waits should pass `r.ownCommitments` directly.
 */
export function recipientCommitments(r: {
    commitments: readonly string[];
    nonZeroCommitments?: readonly string[];
    ownCommitments?: readonly string[];
    recipientCommitment?: string;
}): string[] {
    if (r.recipientCommitment !== undefined) return [r.recipientCommitment];
    const own = new Set(r.ownCommitments ?? []);
    const pool = r.nonZeroCommitments ?? r.commitments;
    return pool.filter((c) => !own.has(c));
}

export async function expectBalanceDeltas(
    token: Erc20Helpers,
    addrs: Record<string, string>,
    before: Record<string, bigint>,
    expected: Record<string, bigint>,
): Promise<void> {
    const after = await snapshotBalances(token, addrs);
    for (const [name, want] of Object.entries(expected)) {
        const got = after[name] - before[name];
        expect(got, `balance delta(${name})`).toBe(want);
    }
}
