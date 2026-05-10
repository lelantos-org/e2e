// Test-side glue around the SDK. The SDK owns crypto, witness, prove,
// relayer/fmd HTTP. This file owns: deterministic-rng test scaffolding,
// ERC20 setup, indexer/explorer poll helpers, and a thin wallet wrapper
// that bundles `SpendingKey` + `OutputRecipient` + `FmdDetectionKey` so
// each test reads as a story instead of as a key-derivation exercise.

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

import { ASSET, FMD_GAMMA, MOCK_ERC20_ABI, TIMEOUT } from "./constants";
import { env } from "./env";
import { cmToHex, pollUntil } from "./utils";

// Re-exported so test files can pull all the knobs from one module.
export { ASSET, FEE_BPS, FMD_GAMMA, MASP_ABI, MOCK_ERC20_ABI, TREE_DEPTH, feeFor, withFee } from "./constants";
export { counter, cmToHex, nfToHex } from "./utils";

// ──────────────────────────────────────────────────────────────────────
// Test wallet
// ──────────────────────────────────────────────────────────────────────

/// Test wallet bundling everything a participant needs:
///   - `keys`        — SDK SpendingKey (nsk → ivk → pk_d, dk, pk).
///   - `recipient`   — OutputRecipient that bundle-builders consume.
///   - `detectionKey` / `flagKey` — FMD γ scalars + on-curve flag points.
export interface TestWallet {
    keys: SpendingKey;
    recipient: OutputRecipient;
    detectionKey: FmdDetectionKey;
    flagKey: FmdFlagKey;
}

/// Derives detection + flag key from the spending key's `dk`, matching
/// what `buildDeposit` / `buildTransfer` do sender-side via
/// `flagKeyFromAddressDk`. Recipient's `dk` is the single seed both
/// sides agree on; that keeps subscriber + sender FMD bits in sync.
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

// ──────────────────────────────────────────────────────────────────────
// Note recipe — produce a fully-populated Note from a recipient + value
// + a randomness source so test code never names rho/rcm/rcv directly.
// ──────────────────────────────────────────────────────────────────────

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
    };
}

/// Fresh per-output randomness for FMD clue + ECDH. Same rng source as
/// the note recipe — keeps every spend reproducible across re-runs.
export function rngForOutput(rng: () => Field): { esk: Field; fmdR: Field } {
    return { esk: rng(), fmdR: rng() };
}

// ──────────────────────────────────────────────────────────────────────
// ERC20 setup
// ──────────────────────────────────────────────────────────────────────

export interface Erc20Helpers {
    contract: ethers.Contract;
    balanceOf(addr: string): Promise<bigint>;
}

/// Mints `initialMint` to the payer and grants Permit2 unbounded
/// allowance. Permit2 is the spender now (MASP pulls funds via
/// `permitWitnessTransferFrom` against the depositor's witness sig).
export async function setupErc20(
    payer: ethers.Wallet,
    tokenAddr: string,
    spender: string,
    initialMint: bigint,
): Promise<Erc20Helpers> {
    const c = new ethers.Contract(tokenAddr, MOCK_ERC20_ABI, payer);
    await (await c.mint(payer.address, initialMint)).wait();
    await (await c.approve(spender, ethers.MaxUint256)).wait();
    return {
        contract: c,
        balanceOf: async (addr) => (await c.balanceOf(addr)) as bigint,
    };
}

const MOCK_WETH9_ABI = [
    "function deposit() payable",
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function balanceOf(address) view returns (uint256)",
];

/// MockWETH9 has no public `mint(address,uint256)`. Wrap raw ETH via
/// `deposit()`, then approve the MASP. Same `Erc20Helpers` shape so the
/// rest of the test code doesn't care which token it is talking to.
export async function setupWeth(
    payer: ethers.Wallet,
    wethAddr: string,
    spender: string,
    amount: bigint,
): Promise<Erc20Helpers> {
    const c = new ethers.Contract(wethAddr, MOCK_WETH9_ABI, payer);
    await (await c.deposit({ value: amount })).wait();
    await (await c.approve(spender, ethers.MaxUint256)).wait();
    return {
        contract: c,
        balanceOf: async (addr) => (await c.balanceOf(addr)) as bigint,
    };
}

// ──────────────────────────────────────────────────────────────────────
// Indexer / explorer polling
// ──────────────────────────────────────────────────────────────────────

/// Wait until fmd-webserver reports the note for `cm` indexed. The
/// listNotes endpoint returns rows ordered by ascending id with a
/// hard limit (server-side cap is 1000) — late in the suite there are
/// hundreds of notes already in the table, so a small `limit` would
/// keep returning the same first page and never surface the freshly
/// indexed cm. Pull the largest page available so any cm produced in
/// this run shows up.
export async function waitForCm(fmd: FmdClient, cm: Field): Promise<FmdNoteOut> {
    const cmHex = cmToHex(cm);
    return pollUntil(async () => {
        const rows = await fmd.listNotes({ limit: 1000 });
        return rows.find((n) => "0x" + n.commitmentHex.toLowerCase() === cmHex);
    }, { label: `fmd notes(${cmHex.slice(0, 12)})`, timeoutMs: TIMEOUT.POLL_DEFAULT_MS });
}

export interface TreeAdvance {
    startIndex: number;
    inserted: number;
    newRootHex: string;
}

/// Wait for the explorer to surface a tree advance starting at `startIndex`.
export async function waitForAdvance(startIndex: number): Promise<TreeAdvance> {
    return pollUntil(async () => {
        const r = await fetch(
            `${env.explorerUrl}/v1/tree-advances?chainId=${env.chainId}&limit=20`,
        );
        if (!r.ok) return null;
        const rows = (await r.json()) as TreeAdvance[];
        return rows.find((t) => t.startIndex === startIndex);
    }, { label: `tree_advance(${startIndex})`, timeoutMs: TIMEOUT.POLL_DEFAULT_MS });
}

// ──────────────────────────────────────────────────────────────────────
// Balance snapshots
// ──────────────────────────────────────────────────────────────────────

/// Read `token.balanceOf` for every address in `addrs`. Output keyed by
/// the address strings the caller passed in — callers use stable env
/// names (payerAddress, maspAddress, recipientAddress) so per-test
/// snapshots line up with their assertions.
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

// ──────────────────────────────────────────────────────────────────────
// Spend-input plumbing
// ──────────────────────────────────────────────────────────────────────

/// Build an SDK `InputSlot` by fetching the merkle path from
/// fmd-webserver. Mirrors what a real wallet does — the indexer is the
/// authoritative tree, so the wallet does not maintain its own.
///
/// E2E tests MUST use this, never a local mirror: tests share the same
/// anvil + indexer DB across files, and any local mirror desyncs as
/// soon as another file lands a tx.
///
/// Derives `cm` from `cached.note` via the SDK's `buildNoteCommitment`
/// — costs one extra Poseidon hash per spend, lets callers carry only
/// the SDK's `SpendableCachedNote` shape (no test-side wrapper type).
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
