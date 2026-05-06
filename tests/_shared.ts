// Test-only shared helpers. Cuts duplication across the e2e suite —
// every test file used to redeclare the same prover paths, the same
// `bundleCommon()` factory, the same fmd-health wait, and the same
// deposit/decrypt recipes. This module owns those; tests stay focused
// on their specific assertions.
//
// Lives under tests/ on purpose — runtime/glue lives in src/scenario.ts;
// this is purely a vitest-side shorthand layer.

import { resolve } from "node:path";

import {
    buildDeposit,
    buildNoteCommitment,
    decodeNotePayload,
    decryptNote,
    type Field,
    type FmdClient,
    type FmdMatchOut,
    type Jubjub,
    type NotePayload,
    type Poseidon,
    type RelayerClient,
    type SpendableCachedNote,
    stripClueBitsPrefix,
} from "@lelantos-org/sdk";

import { RELAYER } from "../src/accounts";
import { env } from "../src/env";
import {
    ASSET,
    counter,
    cmToHex,
    rngForOutput,
    type TestWallet,
    TREE_DEPTH,
    waitForCm,
} from "../src/scenario";
import { hexToBytes, pollUntil } from "../src/utils";

export const PROVER_PATHS = {
    wasmPath: resolve(env.circuitsBuild, "2x2_js", "2x2.wasm"),
    zkeyPath: resolve(env.circuitsBuild, "2x2_final.zkey"),
};

/// Common bundle-builder fields shared by every test. `asset` defaults
/// to the suite-wide `ASSET` constant; multi-asset tests pass it
/// explicitly.
export function makeBundleCommon(P: Poseidon, J: Jubjub, asset: bigint = ASSET) {
    return {
        P, J,
        chainId: env.chainId,
        asset,
        payerAddress: env.payerAddress,
        relayerAddress: RELAYER.address,
        recipientAddress: env.recipientAddress,
        proverPaths: PROVER_PATHS,
        treeDepth: TREE_DEPTH,
    };
}

export async function currentRoot(fmd: FmdClient): Promise<Field> {
    return (await fmd.fetchTreeState()).root;
}

export async function waitForFmdHealth(): Promise<void> {
    await pollUntil(
        async () => {
            const r = await fetch(env.fmdUrl + "/health").catch(() => null);
            return r?.ok ? true : null;
        },
        { label: "fmd health", timeoutMs: 60_000 },
    );
}

/// Shared aux randomness seed — every test currently uses the same one,
/// so reruns produce identical FMD ephemerals. Kept as a factory so each
/// test's stream is independent (calling `counter(...)` returns a fresh
/// closure).
export const auxRngSeed = 0xfacecafen;
export const newAuxRng = () => counter(auxRngSeed);

interface DepositArgs {
    P: Poseidon;
    J: Jubjub;
    relayer: RelayerClient;
    fmd: FmdClient;
    wallet: TestWallet;
    nsk: Field;
    amount: bigint;
    rng: () => Field;
    auxRng: () => Field;
    asset?: bigint;
}

/// Standard deposit recipe used by every test: build → submit → wait
/// for the cm to be indexed → return SDK's `SpendableCachedNote`. Tests
/// re-derive cm via `buildNoteCommitment(P, cached.note)` when needed
/// (inside `inputSlotFor`) — keeps the test-side type identical to the
/// SDK's, no wrapper.
export async function depositToWallet(args: DepositArgs): Promise<SpendableCachedNote> {
    const { P, J, relayer, fmd, wallet, nsk, amount, rng, auxRng, asset } = args;
    const built = await buildDeposit({
        ...makeBundleCommon(P, J, asset),
        publicIn: amount,
        recipient: wallet.recipient,
        output0: { rho: rng(), rcm: rng(), rcv: rng(), aux: rngForOutput(auxRng) },
        output1Pad: { rho: rng(), rcm: rng(), rcv: rng() },
    });
    await relayer.submitTransact(built.payload);
    const indexed = await waitForCm(fmd, built.cm[0]);
    return { note: built.producedNotes[0], nsk, leafIndex: indexed.leafIndex };
}

/// Decrypt an fmd match with the wallet's ivk and re-derive the cm from
/// the recovered payload. Asserts the recomputed cm matches the indexer's
/// commitment — catches impostor / decoy notes that hit the detection
/// key but weren't actually addressed to this wallet.
export async function decryptAndVerifyMatch(
    P: Poseidon,
    J: Jubjub,
    w: TestWallet,
    m: FmdMatchOut,
): Promise<{ payload: NotePayload; cm: Field }> {
    const { body } = stripClueBitsPrefix(hexToBytes(m.ciphertextHex));
    const epkPacked = J.packPoint([BigInt(m.ephPubX), BigInt(m.ephPubY)]);
    const plain = decryptNote({
        J,
        ivk: w.keys.ivk,
        note: { epk: epkPacked, ciphertext: body },
    });
    if (plain === null) throw new Error("decryptNote returned null");
    const payload = decodeNotePayload(plain);
    const cm = buildNoteCommitment(P, {
        asset: payload.asset,
        value: payload.value,
        pk: w.keys.pk,
        rho: payload.rho,
        rcm: payload.rcm,
    });
    if ("0x" + m.commitmentHex.toLowerCase() !== cmToHex(cm)) {
        throw new Error("recomputed cm does not match indexer commitment");
    }
    return { payload, cm };
}
