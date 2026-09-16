// Circuit-level wallet material, ERC-20 setup, and the balance/commitment
// helpers the assertions in `tests/` are written against.

import { expect } from "vitest";

import { ethers } from "ethers";

import type { WalletApi } from "@lelantos-org/sdk";
import { walletInternals } from "@lelantos-org/sdk/internal";
import {
    buildSpendingKey,
    type Field,
    type Jubjub,
    type Poseidon,
    type SpendingKey,
} from "@lelantos-org/sdk/primitives";
import type { OutputRecipient } from "@lelantos-org/sdk/protocol";
import type { FmdClient, FmdNoteOut } from "@lelantos-org/sdk/services";

import { MASP_ABI, MOCK_ERC20_ABI, MOCK_WETH9_ABI } from "./protocol/abi.js";
import type { BundleItem } from "./protocol/logs.js";
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

/**
 * Every note fmd has indexed after row `after`, oldest first, a page at a time.
 *
 * The server returns rows in id order starting after the cursor, so a single
 * `listNotes` call only ever sees the oldest page. Every file shares one index,
 * and a full run passes one page early: from then on a lookup that reads one
 * page never finds a new note, and one asserting a note is absent always
 * passes.
 */
export async function* fmdNotes(fmd: FmdClient, after = 0): AsyncGenerator<FmdNoteOut> {
    for (let cursor = after; ; ) {
        const page = await fmd.listNotes({ limit: LIST_LIMIT, after: cursor });
        yield* page;
        if (page.length < LIST_LIMIT) return;
        cursor = page[page.length - 1].id;
    }
}

/** The indexed note with commitment `cm`, if fmd has it. Scans the whole index. */
export async function findIndexedNote(fmd: FmdClient, cm: Field): Promise<FmdNoteOut | undefined> {
    for await (const n of fmdNotes(fmd)) if (n.cm === cm) return n;
    return undefined;
}

/**
 * Wait for fmd to index `cm`.
 *
 * Each poll resumes from the last row the previous one read: rows are
 * append-only and in id order, so a note not seen yet can only be further on.
 */
export async function waitForCm(fmd: FmdClient, cm: Field): Promise<FmdNoteOut> {
    let cursor = 0;
    return pollUntil(async () => {
        for await (const n of fmdNotes(fmd, cursor)) {
            if (n.cm === cm) return n;
            cursor = n.id;
        }
        return undefined;
    }, { label: `fmd notes(${cmToHex(cm).slice(0, 12)})`, timeoutMs: TIMEOUT.POLL_DEFAULT_MS });
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
 * Cumulative across the run, since every file shares one MASP: an absolute
 * lower bound is already met by whatever ran earlier and proves nothing.
 * Read it before and after the step under test and assert the exact
 * difference; files run serially, so nothing else moves it in between.
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

/**
 * Assert `w` stored `cm` at a leaf `item` inserted.
 *
 * The leaf index comes from the wallet's own fold of the chunk feed, so this
 * ties what the indexer served back to the operation that wrote it: a feed that
 * attributed a bundle's leaves to the wrong operation would place the note
 * outside its item. The leaf index is not on the wallet's public surface, so it
 * is read through `walletInternals`.
 */
export function expectLeafInItem(w: WalletApi, cm: string, item: BundleItem): void {
    const note = walletInternals(w).file.notes.find((n) => n.cm === cm);
    expect(note, `note ${cm} stored`).toBeDefined();
    const leaf = BigInt(note!.leafIndex);
    const end = item.startIndex + item.inserted;
    expect(
        leaf >= item.startIndex && leaf < end,
        `leaf ${leaf} of ${cm} within ${item.kind} item [${item.startIndex}, ${end})`,
    ).toBe(true);
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
