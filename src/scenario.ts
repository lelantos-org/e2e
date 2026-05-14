import { expect } from "vitest";

import { ethers } from "ethers";

import {
    buildNoteCommitment,
    buildSpendingKey,
    type Field,
    flagKeyFromAddressDk,
    FmdClient,
    type FmdDetectionKey,
    type FmdFlagKey,
    type FmdNoteOut,
    type InputSlot,
    type Jubjub,
    type Note,
    type OutputRecipient,
    type Poseidon,
    type SpendableCachedNote,
    type SpendingKey,
} from "@lelantos-org/sdk";

import { ASSET, FMD_GAMMA, MOCK_ERC20_ABI, MOCK_WETH9_ABI, TIMEOUT } from "./constants.js";
import { env } from "./env.js";
import { ExplorerClient, type TreeAdvance } from "./explorer-client.js";
import { cmToHex, pollUntil } from "./utils.js";

export type { TreeAdvance } from "./explorer-client.js";
export { ExplorerClient } from "./explorer-client.js";
export { ASSET, FEE_BPS, FMD_GAMMA, MASP_ABI, MOCK_ERC20_ABI, TREE_DEPTH, feeFor, withFee } from "./constants.js";
export { counter, cmToHex, nfToHex } from "./utils.js";

export interface TestWallet {
    keys: SpendingKey;
    recipient: OutputRecipient;
    detectionKey: FmdDetectionKey;
    flagKey: FmdFlagKey;
}

export function makeWallet(P: Poseidon, J: Jubjub, nsk: Field): TestWallet {
    const keys = buildSpendingKey(P, J, nsk);
    const { detection, flag } = flagKeyFromAddressDk(J, keys.dk, FMD_GAMMA);
    return {
        keys,
        recipient: { pk_d: keys.pk_d, dk: keys.dk, pk: keys.pk },
        detectionKey: detection,
        flagKey: flag,
    };
}

export function noteFor(
    w: TestWallet,
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
    payer: ethers.NonceManager,
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
    payer: ethers.NonceManager,
    wethAddr: string,
    spender: string,
    amount: bigint,
): Promise<Erc20Helpers> {
    const c = new ethers.Contract(wethAddr, MOCK_WETH9_ABI, payer);
    await (await c.deposit({ value: amount })).wait();
    await approveSpender(c, spender);
    return erc20Helpers(c);
}

// fmd-webserver caps listNotes at 1000 rows; ask for the max so a freshly
// indexed cm is not buried behind older pages.
export async function waitForCm(fmd: FmdClient, cm: Field): Promise<FmdNoteOut> {
    const cmHex = cmToHex(cm);
    return pollUntil(async () => {
        const rows = await fmd.listNotes({ limit: 1000 });
        return rows.find((n) => "0x" + n.commitmentHex.toLowerCase() === cmHex);
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

export async function snapshotBalances(
    token: Erc20Helpers,
    addrs: Record<string, string>,
): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {};
    for (const [name, addr] of Object.entries(addrs)) {
        out[name] = await token.balanceOf(addr);
    }
    return out;
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

// Tests share one anvil + indexer DB across files; a local merkle mirror
// would desync as soon as another file lands a tx, so always pull from fmd.
export async function inputSlotFor(
    P: Poseidon,
    fmd: FmdClient,
    cached: SpendableCachedNote,
): Promise<InputSlot> {
    const cm = buildNoteCommitment(P, cached.note);
    const path = await fmd.fetchPath(cmToHex(cm));
    return {
        cached: { ...cached, leafIndex: path.leafIndex },
        pathElements: path.pathElements,
        pathIndices: path.pathIndices,
    };
}
