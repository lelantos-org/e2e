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
    type Field,
    type Note,
    type SpentNote,
} from "@lelantos/sdk";

import { env } from "./env";
import type { OutputAuxDto, PubInputsDto, SubmitTransactPayload } from "./relayer-client";

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

export const emptyAux: OutputAuxDto = {
    clue_r: { x: "0", y: "0" },
    eph_pub: { x: "0", y: "0" },
    ciphertext: "0x0000",
};

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
    /// Optional per-slot aux. Defaults to `emptyAux` (zero clue + 2-byte
    /// ciphertext "0x0000"). Real wallets populate FMD clue + encrypted
    /// note payload — see e2e/runner/src/wallet.ts::buildOutputAux.
    aux?: [OutputAuxDto, OutputAuxDto];
}

async function buildPayload(opts: ProveOpts): Promise<SubmitTransactPayload> {
    const { P, J, inputs, outputs, merkleRoot, publicIn, publicOut } = opts;
    const pubGen = J.hashToAssetGen(ASSET);

    const baseInput = toCircomInput(P, J, {
        publicAssetId: ASSET,
        publicAssetGen: pubGen,
        publicIn,
        publicOut,
        inputs,
        outputs,
        merkleRoot,
        recipientAddress: addrToDec(opts.recipientAddress),
        chainId: env.chainId,
        payerAddress: addrToDec(opts.payerAddress),
        relayerAddress: addrToDec(opts.relayerAddress),
        z: 0n,
    });

    const coeffs = flatten(baseInput as any);
    const z = fiatShamirZ(coeffs);
    const input = { ...baseInput, z: z.toString() };

    const wasm = resolve(env.circuitsBuild, "2x2_js", "2x2.wasm");
    const zkey = resolve(env.circuitsBuild, "2x2_final.zkey");

    const { proof, publicSignals } = await groth16.fullProve(input, wasm, zkey);
    if (publicSignals.length !== 2) {
        throw new Error(`expected 2 public signals, got ${publicSignals.length}`);
    }

    const pubInputs: PubInputsDto = {
        merkle_root: toDec((baseInput as any).merkle_root),
        nullifier: [
            toDec((baseInput as any).nullifier[0]),
            toDec((baseInput as any).nullifier[1]),
        ],
        out_cm: [
            toDec((baseInput as any).out_cm[0]),
            toDec((baseInput as any).out_cm[1]),
        ],
        public_asset_id: Number(ASSET),
        pub_asset_gen: { x: toDec(pubGen[0]), y: toDec(pubGen[1]) },
        public_in: Number(publicIn),
        public_out: Number(publicOut),
        in_cv: [
            { x: toDec((baseInput as any).in_cv[0][0]), y: toDec((baseInput as any).in_cv[0][1]) },
            { x: toDec((baseInput as any).in_cv[1][0]), y: toDec((baseInput as any).in_cv[1][1]) },
        ],
        out_cv: [
            { x: toDec((baseInput as any).out_cv[0][0]), y: toDec((baseInput as any).out_cv[0][1]) },
            { x: toDec((baseInput as any).out_cv[1][0]), y: toDec((baseInput as any).out_cv[1][1]) },
        ],
        recipient: opts.recipientAddress,
        chain_id: Number(env.chainId),
        payer: opts.payerAddress,
        relayer: opts.relayerAddress,
    };

    return {
        chain_id: Number(env.chainId),
        proof2x2: {
            pi_a: proof.pi_a,
            pi_b: proof.pi_b,
            pi_c: proof.pi_c,
        },
        pub_inputs: pubInputs,
        aux: opts.aux ?? [emptyAux, emptyAux],
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
    aux?: [OutputAuxDto, OutputAuxDto];
}): Promise<BundleResult> {
    const sumIn = params.cached.note.value;
    const sumOut = params.outputs[0].value + params.outputs[1].value;
    if (sumOut !== sumIn) {
        throw new Error(`transfer balance: in=${sumIn} out=${sumOut}`);
    }

    const realIn = toSpentNote(P, params.cached, params.tree);
    const dummy = dummyInputAt(P, DEPTH, 200n);

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
        aux: params.aux,
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
