// Bundle builders for the three transact shapes the e2e suite drives:
//   - deposit:   2 dummies in, 1 real out + 1 padding, publicIn>0, publicOut=0.
//   - transfer:  1 real spend + 1 dummy in, 2 real outs (split), publicIn=publicOut=0.
//   - withdraw:  1 real spend + 1 dummy in, 2 padding outs, publicIn=0, publicOut>0.
//
// Each builder returns the exact `SubmitTransactPayload` the relayer expects.

import { resolve } from "path";
// snarkjs has no published TS types
// @ts-ignore
import { groth16 } from "snarkjs";

import {
    Poseidon,
    Jubjub,
    derivePk,
    toCircomInput,
    dummyInputAt,
    flatten,
    fiatShamirZ,
    MerkleTree,
    buildNoteCommitment,
    buildNullifier,
    fmdGenDetectionKey,
    fmdFlagKeyFromDetection,
    type Field,
    type Note,
    type SpentNote,
} from "@lelantos-org/sdk";

import { buildOutputAux, type OutputAuxWithWitness } from "./wallet";
import { env } from "./env";
import type { OutputAuxDto, PubInputsDto, SubmitTransactPayload } from "./relayer-client";

const FMD_GAMMA = 5;

const DEPTH = 10;
const ASSET = 1n;
export const ALICE_NSK = 11n;
export const BOB_NSK = 22n;

const RELAYER_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function toDec(v: Field | bigint | string | number): string {
    return BigInt(v as any).toString();
}

function addrToDec(addr: string): bigint {
    return BigInt(addr);
}

function cmHex(cm: Field): string {
    return "0x" + BigInt(cm).toString(16).padStart(64, "0");
}

/// Build a real but throw-away clue for pad/dummy outputs.
/// Uses a fresh random detection key so the clue lands on no real
/// subscription (FP rate 2^-γ). Required since the SNARK ClueCheck
/// constrains every output slot.
export function makePadAux(P: Poseidon, J: Jubjub, note: Note, seed: number): OutputAuxWithWitness {
    let s = BigInt(seed) | 1n;
    const stream = (): bigint => {
        s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n);
        return s | 1n;
    };
    const dk = fmdGenDetectionKey(stream, FMD_GAMMA);
    const fk = fmdFlagKeyFromDetection(J, dk);
    return buildOutputAux({
        J,
        P,
        recipientFlagKey: fk,
        recipientPkD: J.base8,
        fmdR: stream(),
        esk: stream(),
        note,
    });
}

interface ProveOpts {
    P: Poseidon;
    J: Jubjub;
    inputs: SpentNote[];
    outputs: Note[];
    merkleRoot: Field;
    publicIn: bigint;
    publicOut: bigint;
    payerAddress: string;
    relayerAddress: string;
    recipientAddress: string;
    /// Per-slot aux + clue witness. SNARK ClueCheck constrains every
    /// output slot, so both must carry a real (r, fk) pair — pads use
    /// `makePadAux()` for a throw-away clue.
    auxWitnessed: [OutputAuxWithWitness, OutputAuxWithWitness];
}

async function buildPayload(opts: ProveOpts): Promise<SubmitTransactPayload> {
    const { P, J, inputs, outputs, merkleRoot, publicIn, publicOut, auxWitnessed } = opts;
    const pubGen = J.hashToAssetGen(ASSET);
    const aux: [OutputAuxDto, OutputAuxDto] = [auxWitnessed[0].aux, auxWitnessed[1].aux];
    const outputClues = auxWitnessed.map((a) => a.witness);

    const baseInput = toCircomInput(P, J, {
        publicAssetId: ASSET,
        publicAssetGen: pubGen,
        publicIn,
        publicOut,
        inputs,
        outputs,
        outputClues,
        merkleRoot,
        recipientAddress: addrToDec(opts.recipientAddress),
        chainId: env.chainId,
        payerAddress: addrToDec(opts.payerAddress),
        relayerAddress: addrToDec(opts.relayerAddress),
        z: 0n,
    });

    const flattenInput = {
        ...(baseInput as any),
        out_clue_Rx: aux.map((a) => BigInt(a.clueR.x)),
        out_clue_Ry: aux.map((a) => BigInt(a.clueR.y)),
        out_clue_bits: outputClues.map((c) => c.clueBits),
    };
    const coeffs = flatten(flattenInput);
    const z = fiatShamirZ(coeffs);
    const input = { ...baseInput, z: z.toString() };

    const wasm = resolve(env.circuitsBuild, "2x2_js", "2x2.wasm");
    const zkey = resolve(env.circuitsBuild, "2x2_final.zkey");

    const { proof, publicSignals } = await groth16.fullProve(input, wasm, zkey);
    if (publicSignals.length !== 2) {
        throw new Error(`expected 2 public signals, got ${publicSignals.length}`);
    }

    const pubInputs: PubInputsDto = {
        merkleRoot: toDec((baseInput as any).merkle_root),
        nullifier: [
            toDec((baseInput as any).nullifier[0]),
            toDec((baseInput as any).nullifier[1]),
        ],
        outCm: [
            toDec((baseInput as any).out_cm[0]),
            toDec((baseInput as any).out_cm[1]),
        ],
        publicAssetId: Number(ASSET),
        pubAssetGen: { x: toDec(pubGen[0]), y: toDec(pubGen[1]) },
        publicIn: Number(publicIn),
        publicOut: Number(publicOut),
        inCv: [
            { x: toDec((baseInput as any).in_cv[0][0]), y: toDec((baseInput as any).in_cv[0][1]) },
            { x: toDec((baseInput as any).in_cv[1][0]), y: toDec((baseInput as any).in_cv[1][1]) },
        ],
        outCv: [
            { x: toDec((baseInput as any).out_cv[0][0]), y: toDec((baseInput as any).out_cv[0][1]) },
            { x: toDec((baseInput as any).out_cv[1][0]), y: toDec((baseInput as any).out_cv[1][1]) },
        ],
        recipient: opts.recipientAddress,
        chainId: Number(env.chainId),
        payer: opts.payerAddress,
        relayer: opts.relayerAddress,
    };

    return {
        chainId: Number(env.chainId),
        proof2x2: {
            piA: proof.pi_a,
            piB: proof.pi_b,
            piC: proof.pi_c,
        },
        pubInputs,
        aux,
    };
}

/// Locally-tracked produced note (so the test can later spend it).
export interface ProducedNote {
    note: Note;
    cm: Field;
    leafIndex: number;
}

export interface BundleResult {
    payload: SubmitTransactPayload;
    cm0Hex: string;
    cm1Hex: string;
    /// The two notes the prover produced, indexed in slot order. Tests
    /// copy these into a local cache to spend later.
    producedNotes: [Note, Note];
}

// ---------- DEPOSIT ----------

export async function buildDeposit(P: Poseidon, J: Jubjub, params: {
    publicIn: bigint;
    payerAddress: string;
    recipientAddress: string;
}): Promise<BundleResult> {
    const dA = dummyInputAt(P, DEPTH, 100n);
    const dB = dummyInputAt(P, DEPTH, 101n);

    const aliceP: Field = derivePk(P, ALICE_NSK);
    const realOut: Note = { asset: ASSET, value: params.publicIn, pk: aliceP, rho: 9n,  rcm: 10n, rcv: 11n };
    const padOut:  Note = { asset: ASSET, value: 0n,            pk: aliceP, rho: 12n, rcm: 13n, rcv: 14n };

    const root = new MerkleTree(P, DEPTH).root();
    const aux0 = makePadAux(P, J, realOut, 0xa0);
    const aux1 = makePadAux(P, J, padOut, 0xa1);
    const payload = await buildPayload({
        P, J,
        inputs: [dA, dB],
        outputs: [realOut, padOut],
        merkleRoot: root,
        publicIn: params.publicIn,
        publicOut: 0n,
        payerAddress: params.payerAddress,
        relayerAddress: RELAYER_ADDR,
        recipientAddress: params.recipientAddress,
        auxWitnessed: [aux0, aux1],
    });

    const cm0 = buildNoteCommitment(P, realOut);
    const cm1 = buildNoteCommitment(P, padOut);
    return {
        payload,
        cm0Hex: cmHex(cm0),
        cm1Hex: cmHex(cm1),
        producedNotes: [realOut, padOut],
    };
}

// ---------- SHIELDED TRANSFER ----------

export interface SpendableCachedNote {
    note: Note;
    nsk: Field;
    leafIndex: number;
}

/// Spend `cached` (1 real + 1 dummy) and split into two new outputs.
/// Sum of output values MUST equal cached.note.value (publicIn=publicOut=0).
export async function buildTransfer(P: Poseidon, J: Jubjub, params: {
    cached: SpendableCachedNote;
    tree: MerkleTree;
    merkleRoot: Field;
    outputs: [Note, Note];
    payerAddress: string;
    recipientAddress: string;
    auxWitnessed?: [OutputAuxWithWitness, OutputAuxWithWitness];
}): Promise<BundleResult> {
    const sumIn = params.cached.note.value;
    const sumOut = params.outputs[0].value + params.outputs[1].value;
    if (sumOut !== sumIn) {
        throw new Error(`transfer balance: in=${sumIn} out=${sumOut}`);
    }

    const realIn = toSpentNote(P, params.cached, params.tree);
    const dummy = dummyInputAt(P, DEPTH, 200n);

    const auxW: [OutputAuxWithWitness, OutputAuxWithWitness] = params.auxWitnessed ?? [
        makePadAux(P, J, params.outputs[0], 0xb0),
        makePadAux(P, J, params.outputs[1], 0xb1),
    ];
    const payload = await buildPayload({
        P, J,
        inputs: [realIn, dummy],
        outputs: params.outputs,
        merkleRoot: params.merkleRoot,
        publicIn: 0n,
        publicOut: 0n,
        payerAddress: params.payerAddress,
        relayerAddress: RELAYER_ADDR,
        recipientAddress: params.recipientAddress,
        auxWitnessed: auxW,
    });

    const cm0 = buildNoteCommitment(P, params.outputs[0]);
    const cm1 = buildNoteCommitment(P, params.outputs[1]);
    return {
        payload,
        cm0Hex: cmHex(cm0),
        cm1Hex: cmHex(cm1),
        producedNotes: params.outputs,
    };
}

// ---------- WITHDRAW ----------

/// Spend `cached`. publicOut moves to the chain's `recipient`. Two
/// `change` outputs make up the remainder; they MUST sum to
/// (cached.note.value - publicOut).
export async function buildWithdraw(P: Poseidon, J: Jubjub, params: {
    cached: SpendableCachedNote;
    tree: MerkleTree;
    merkleRoot: Field;
    publicOut: bigint;
    change: [Note, Note];
    payerAddress: string;
    recipientAddress: string;
}): Promise<BundleResult> {
    const sumIn = params.cached.note.value;
    const sumChange = params.change[0].value + params.change[1].value;
    if (sumIn !== params.publicOut + sumChange) {
        throw new Error(`withdraw balance: in=${sumIn} publicOut=${params.publicOut} change=${sumChange}`);
    }

    const realIn = toSpentNote(P, params.cached, params.tree);
    const dummy = dummyInputAt(P, DEPTH, 300n);

    const auxW: [OutputAuxWithWitness, OutputAuxWithWitness] = [
        makePadAux(P, J, params.change[0], 0xc0),
        makePadAux(P, J, params.change[1], 0xc1),
    ];
    const payload = await buildPayload({
        P, J,
        inputs: [realIn, dummy],
        outputs: params.change,
        merkleRoot: params.merkleRoot,
        publicIn: 0n,
        publicOut: params.publicOut,
        payerAddress: params.payerAddress,
        relayerAddress: RELAYER_ADDR,
        recipientAddress: params.recipientAddress,
        auxWitnessed: auxW,
    });

    const cm0 = buildNoteCommitment(P, params.change[0]);
    const cm1 = buildNoteCommitment(P, params.change[1]);
    return {
        payload,
        cm0Hex: cmHex(cm0),
        cm1Hex: cmHex(cm1),
        producedNotes: params.change,
    };
}

// ---------- helpers ----------

function toSpentNote(P: Poseidon, cached: SpendableCachedNote, tree: MerkleTree): SpentNote {
    const cm = buildNoteCommitment(P, cached.note);
    const nf = buildNullifier(P, cached.nsk, cached.note.rho);
    const proof = tree.proof(cached.leafIndex);
    return {
        ...cached.note,
        nsk: cached.nsk,
        cm,
        nf,
        leafIndex: cached.leafIndex,
        pathElements: proof.pathElements,
        pathIndices: proof.pathIndices,
        isDummy: false,
    };
}
