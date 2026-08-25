import { expect } from "vitest";

import { ethers } from "ethers";

import type { OutputRecipient } from "@lelantos-org/sdk/bundle";
import type { Field, Jubjub, Poseidon } from "@lelantos-org/sdk/crypto";
import { type FmdDetectionKey, type FmdFlagKey, fmdFlagKeyFromDetection } from "@lelantos-org/sdk/fmd";
import { FmdClient, type FmdNoteOut } from "@lelantos-org/sdk/fmd-server";
import { buildSpendingKey, detectionKeyFor, type SpendingKey } from "@lelantos-org/sdk/keys";
import type { Note } from "@lelantos-org/sdk/notes";

import { MASP_ABI, MOCK_ERC20_ABI, MOCK_WETH9_ABI } from "./protocol/abi.js";
import { ASSET } from "./protocol/assets.js";
import { FMD_GAMMA, N_OUT } from "./protocol/shape.js";
import { LIST_LIMIT, TIMEOUT } from "./testkit/timeouts.js";
import { env } from "./env.js";
import { ExplorerClient, type TreeAdvance } from "./explorer-client.js";
import { cmToHex, pollUntil } from "./utils.js";

export interface CircuitWallet {
    keys: SpendingKey;
    recipient: OutputRecipient;
    detectionKey: FmdDetectionKey;
    flagKey: FmdFlagKey;
}

export function makeWallet(P: Poseidon, J: Jubjub, nsk: Field): CircuitWallet {
    const keys = buildSpendingKey(P, J, nsk);
    // `SpendingKey` structurally satisfies `ViewingKey` (ivk / pk_d / dk / ck),
    // which is what `detectionKeyFor` wants.
    const detection = detectionKeyFor(J, P, keys, FMD_GAMMA);
    return {
        keys,
        // An `OutputRecipient` carries the *public* clue key `ck`, never the
        // root detection secret `dk` — expanding `ck` yields flag-key points
        // and nothing else.
        recipient: { pk_d: keys.pk_d, pk: keys.pk, ck: keys.ck },
        detectionKey: detection,
        flagKey: fmdFlagKeyFromDetection(J, detection),
    };
}

export function noteFor(
    w: CircuitWallet,
    value: bigint,
    rng: () => Field,
    asset: bigint = ASSET,
): Note {
    return {
        asset,
        value,
        pk: w.keys.pk,
        rho: rng(),
        rcm: rng(),
        rcv: rng(),
        rcvDep: rng(),
    };
}

export function rngForOutput(rng: () => Field): { esk: Field; fmdR: Field } {
    return { esk: rng(), fmdR: rng() };
}

/**
 * Pad a spend's outputs up to the circuit's `nOut` with zero-value notes back
 * to `self`. `buildSpend` takes exactly `nOut` outputs and enforces the balance
 * equation, so the pads must carry value 0 and their own fresh randomness.
 */
export function padOutputs(
    self: CircuitWallet,
    outputs: readonly Note[],
    rng: () => Field,
    asset: bigint = ASSET,
    nOut: number = N_OUT,
): Note[] {
    if (outputs.length > nOut) {
        throw new Error(`padOutputs: ${outputs.length} outputs exceeds nOut=${nOut}`);
    }
    const out = [...outputs];
    while (out.length < nOut) out.push(noteFor(self, 0n, rng, asset));
    return out;
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

// Ask for `LIST_LIMIT` (the server's max) so a freshly indexed cm is not
// buried behind older pages.
export async function waitForCm(fmd: FmdClient, cm: Field): Promise<FmdNoteOut> {
    const cmHex = cmToHex(cm);
    return pollUntil(async () => {
        const rows = await fmd.listNotes({ limit: LIST_LIMIT });
        return rows.find((n) => n.cm === cm);
    }, { label: `fmd notes(${cmHex.slice(0, 12)})`, timeoutMs: TIMEOUT.POLL_DEFAULT_MS });
}

export async function waitForAdvance(
    startIndex: number,
    client: ExplorerClient = new ExplorerClient(env.explorerUrl, env.chainId),
): Promise<TreeAdvance> {
    return pollUntil(async () => {
        const rows = await client.treeAdvances({ limit: 20 }).catch(() => null);
        return rows?.find((t) => t.startIndex === startIndex);
    }, { label: `tree_advance(${startIndex})`, timeoutMs: TIMEOUT.POLL_DEFAULT_MS });
}

/**
 * The three accounts every ERC-20 balance assertion in the suite tracks:
 * where the money comes from, where it is held while shielded, and where it
 * lands on the way out. Lazily read so `env` is not touched at import time.
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
 * Always assert this with `toBeGreaterThanOrEqual`: the counter is cumulative
 * across the whole run and every test file shares one MASP, so any file that
 * deposits or withdraws the same asset raises it. An exact assertion here
 * would encode the file ordering into the test.
 */
export async function accruedFee(
    provider: ethers.Provider,
    tokenAddr: string,
): Promise<bigint> {
    _feeView ??= new ethers.Contract(env.maspAddress, MASP_ABI, provider);
    return (await _feeView.accruedFee(tokenAddr)) as bigint;
}

/**
 * Commitments the *counterparty* is expected to scan.
 *
 * "Not the sender's" is not a usable definition. A fee-paying spend has a third
 * kind of output — a note addressed to the relayer — which is non-zero and not
 * the sender's, so a receiver-side wait built by elimination blocks forever on
 * a note only the relayer can decrypt.
 *
 * Nor is there an index to read the payee off: the SDK shuffles output slots,
 * because slot order is the last thing in the output vector that would say
 * which commitment is the payee's and which is the relayer's. So the result
 * carries `recipientCommitment` explicitly and this uses it, falling back to
 * elimination only for the kinds that have no single payee.
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
