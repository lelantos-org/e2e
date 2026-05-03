// Recipient-side wallet helpers. Mirrors what a real Lelantos wallet would
// do client-side:
//   1. Derive keys (nsk → ivk, pk_d, dk).
//   2. Subscribe to fmd-webserver with the FMD detection key.
//   3. Poll /v1/matches → for each match, decrypt ciphertext via ivk → cm
//      → known plaintext (asset, value, rho, rcm).
//   4. Sum unspent values per asset to compute balance.

import {
    Poseidon,
    Jubjub,
    buildSpendingKey,
    fmdGenDetectionKey,
    fmdFlagKeyFromDetection,
    fmdFlag,
    encryptNote,
    decryptNote,
    BABYJUB_SUBGROUP_ORDER,
    type Field,
    type Point,
    type SpendingKey,
    type FmdDetectionKey,
    type FmdFlagKey,
    type Note,
} from "@lelantos-org/sdk";

import { env } from "./env";
import type { OutputAuxDto } from "./relayer-client";

export const FMD_GAMMA = 5;

export interface Wallet {
    nsk: Field;
    keys: SpendingKey;
    detectionKey: FmdDetectionKey;
    flagKey: FmdFlagKey;
}

export function makeWallet(P: Poseidon, J: Jubjub, nsk: Field, randomScalar: () => Field): Wallet {
    const keys = buildSpendingKey(P, J, nsk);
    const detectionKey = fmdGenDetectionKey(randomScalar, FMD_GAMMA);
    const flagKey = fmdFlagKeyFromDetection(J, detectionKey);
    return { nsk, keys, detectionKey, flagKey };
}

/// Encode the detection key for the rust filter: γ × 32-byte little-endian
/// scalars concatenated.
export function encodeDetectionKeyHex(dk: FmdDetectionKey): string {
    const out = new Uint8Array(dk.x.length * 32);
    for (let i = 0; i < dk.x.length; i++) {
        const bytes = bigintToLeBytes(dk.x[i], 32);
        out.set(bytes, i * 32);
    }
    return "0x" + bytesToHex(out);
}

function bigintToLeBytes(v: bigint, len: number): Uint8Array {
    let n = v;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    if (n !== 0n) throw new Error(`bigintToLeBytes: ${v} > 2^${len * 8}`);
    return out;
}

/// Build the on-chain OutputAux for a note destined for `recipient`. Wraps:
///   - FMD clue R + bits prefix
///   - ECDH ephemeral pub epk
///   - ChaCha20-Poly1305 ciphertext of the plaintext (asset|value|rho|rcm).
export interface OutputAuxWithWitness {
    aux: OutputAuxDto;
    /// FMD clue witness for the SNARK ClueCheck template.
    witness: { r: Field; fk: Point[]; clueBits: Field };
}

export function buildOutputAux(args: {
    J: Jubjub;
    P: Poseidon;
    recipientFlagKey: FmdFlagKey;
    recipientPkD: Point;
    fmdR: Field;
    esk: Field;
    note: Note;
}): OutputAuxWithWitness {
    const { J, P, recipientFlagKey, recipientPkD, fmdR, esk, note } = args;

    const clue = fmdFlag(J, P, recipientFlagKey, fmdR);
    const clueRPoint = J.unpackPoint(clue.R);
    if (!clueRPoint) throw new Error("clue R unpack failed");

    // Pack clue bits into a 16-bit big-endian prefix. fmd.ts emits bits as
    // a byte array LSB-first; γ=5 fits in 1 byte; we widen to u16.
    let bitsU16 = 0;
    for (let i = 0; i < clue.gamma; i++) {
        const b = (clue.bits[i >> 3] >> (i & 7)) & 1;
        if (b) bitsU16 |= 1 << i;
    }
    const prefix = new Uint8Array(2);
    prefix[0] = (bitsU16 >> 8) & 0xff;
    prefix[1] = bitsU16 & 0xff;

    // ChaCha20-Poly1305 over (asset:8 LE | value:8 LE | rho:32 LE | rcm:32 LE).
    const plaintext = packNotePlaintext(note);
    const enc = encryptNote({ J, recipientPkD, esk, plaintext });

    const ephPub = J.unpackPoint(enc.epk);
    if (!ephPub) throw new Error("epk unpack failed");

    const ciphertext = new Uint8Array(prefix.length + enc.ciphertext.length);
    ciphertext.set(prefix, 0);
    ciphertext.set(enc.ciphertext, prefix.length);

    let clueBitsField: bigint = 0n;
    for (let i = 0; i < clue.gamma; i++) {
        const b = (clue.bits[i >> 3] >> (i & 7)) & 1;
        if (b) clueBitsField |= 1n << BigInt(i);
    }

    return {
        aux: {
            clueR: { x: clueRPoint[0].toString(), y: clueRPoint[1].toString() },
            ephPub: { x: ephPub[0].toString(), y: ephPub[1].toString() },
            ciphertext: "0x" + bytesToHex(ciphertext),
        },
        witness: {
            r: fmdR,
            fk: recipientFlagKey.X,
            clueBits: clueBitsField,
        },
    };
}

export function packNotePlaintext(n: Note): Uint8Array {
    const buf = new Uint8Array(8 + 8 + 32 + 32);
    writeLe(buf, 0, n.asset, 8);
    writeLe(buf, 8, n.value, 8);
    writeLe(buf, 16, n.rho, 32);
    writeLe(buf, 48, n.rcm, 32);
    return buf;
}

export function unpackNotePlaintext(buf: Uint8Array): { asset: bigint; value: bigint; rho: bigint; rcm: bigint } {
    if (buf.length !== 80) throw new Error(`note plaintext length ${buf.length} != 80`);
    return {
        asset: readLe(buf, 0, 8),
        value: readLe(buf, 8, 8),
        rho: readLe(buf, 16, 32),
        rcm: readLe(buf, 48, 32),
    };
}

function writeLe(buf: Uint8Array, off: number, v: bigint, len: number) {
    let n = v;
    for (let i = 0; i < len; i++) {
        buf[off + i] = Number(n & 0xffn);
        n >>= 8n;
    }
}

function readLe(buf: Uint8Array, off: number, len: number): bigint {
    let v = 0n;
    for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
    return v;
}

/// Random scalar for ESK / FMD r. Tests use a seeded counter (deterministic
/// re-runs); production wallets use cryptographically-strong randomness.
export function makeCounterScalar(seed: bigint): () => Field {
    let n = seed;
    return () => {
        n += 1n;
        const v = (n * 0x9e3779b97f4a7c15n) % BABYJUB_SUBGROUP_ORDER;
        return v === 0n ? 1n : v;
    };
}

export interface MatchOut {
    noteId: number;
    chainId: number;
    blockNumber: number;
    leafIndex: number;
    commitmentHex: string;
    clueBitsHex: string;
    ciphertextHex: string;
    ephPubX: string;
    ephPubY: string;
}

export async function fetchMatches(subscriptionId: number): Promise<MatchOut[]> {
    const r = await fetch(
        `${env.fmdUrl}/v1/matches?subscription=${subscriptionId}&limit=100`,
    );
    if (!r.ok) throw new Error(`/v1/matches: ${r.status}`);
    return (await r.json()) as MatchOut[];
}

export async function createSubscription(detectionKeyHex: string, gamma: number): Promise<number> {
    const r = await fetch(`${env.fmdUrl}/v1/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionKeyHex, gamma }),
    });
    if (!r.ok) throw new Error(`POST /v1/subscriptions: ${r.status} ${await r.text()}`);
    const body = (await r.json()) as { id: number };
    return body.id;
}

/// Try to decrypt one match using `ivk`. Returns the recovered plaintext
/// (asset, value, rho, rcm) or null if not for this wallet (tag failure).
export function tryDecryptMatch(
    J: Jubjub,
    ivk: Field,
    m: MatchOut,
): { asset: bigint; value: bigint; rho: bigint; rcm: bigint } | null {
    const ct = hexToBytes(m.ciphertextHex);
    if (ct.length < 2) return null;
    const body = ct.slice(2); // strip the 2-byte clueBits prefix

    const ephPubPoint: Point = [BigInt(m.ephPubX), BigInt(m.ephPubY)];
    const epkPacked = J.packPoint(ephPubPoint);

    const plain = decryptNote({ J, ivk, note: { epk: epkPacked, ciphertext: body } });
    if (!plain) return null;
    return unpackNotePlaintext(plain);
}

/// Walk all matches, decrypt the ones we can, sum values for `asset`.
export function syncBalance(
    J: Jubjub,
    ivk: Field,
    matches: MatchOut[],
    asset: bigint,
): { decrypted: { asset: bigint; value: bigint }[]; balance: bigint } {
    const decrypted: { asset: bigint; value: bigint }[] = [];
    let balance = 0n;
    for (const m of matches) {
        const p = tryDecryptMatch(J, ivk, m);
        if (!p) continue;
        decrypted.push({ asset: p.asset, value: p.value });
        if (p.asset === asset) balance += p.value;
    }
    return { decrypted, balance };
}

function hexToBytes(s: string): Uint8Array {
    const stripped = s.startsWith("0x") ? s.slice(2) : s;
    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(stripped.slice(2 * i, 2 * i + 2), 16);
    }
    return out;
}

function bytesToHex(b: Uint8Array): string {
    let h = "";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}
