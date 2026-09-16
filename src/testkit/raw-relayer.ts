// Talking to the relayer the way the wallet does, without the wallet.
//
// Two tests need this. One asserts the relayer refuses a malformed submission
// before it spends gas, which means sending bodies no SDK would build. The
// other asserts a retry under one `Idempotency-Key` lands once, which means
// seeing the key the SDK chose and replaying it.
//
// Both work off a captured request rather than a re-encoded one: the wallet's
// own submit is recorded verbatim — url, headers, body — so a tampered copy
// differs from a valid submission only in the field under test. Re-encoding the
// payload here would make the relayer's wire format a second source of truth,
// and a mismatch would read as the relayer refusing the tampered field when it
// was really refusing the encoding.

import { ethers } from "ethers";

import { RELAYER } from "../accounts.js";
import { TIMEOUT } from "./timeouts.js";

/** One request the wallet's transport made, as it went on the wire. */
export interface CapturedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    /** Verbatim body; `json()` parses it. */
    body: string;
    /** The `Idempotency-Key` header, which a submit always carries. */
    idempotencyKey?: string;
    json<T = Record<string, unknown>>(): T;
}

export interface SubmitCapture {
    /** Pass as `CreateWalletOpts.fetch`. */
    fetch: typeof fetch;
    /** Every submit seen so far, oldest first. Reads and estimates are not recorded. */
    readonly requests: readonly CapturedRequest[];
    /** The last submit, or throw naming what was seen instead. */
    last(): CapturedRequest;
}

/** A request is a spend or swap submission, not an estimate or a read. */
function isSubmit(url: string, method: string): boolean {
    return method.toUpperCase() === "POST" && /\/v1\/(spend|swap)$/.test(new URL(url).pathname);
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
        out[k] = v;
    });
    return out;
}

function captured(url: string, init: RequestInit | undefined): CapturedRequest {
    const headers = headerRecord(init);
    const body = typeof init?.body === "string" ? init.body : "";
    const key = headers["idempotency-key"];
    return {
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        headers,
        body,
        ...(key !== undefined ? { idempotencyKey: key } : {}),
        json: <T>() => JSON.parse(body) as T,
    };
}

/**
 * Record every submit a wallet makes, and optionally hold or refuse it.
 *
 * `onSubmit` runs before the request is forwarded: returning a `Response`
 * answers it without reaching the relayer, throwing fails the attempt (which is
 * how the SDK sees a lost connection), and returning nothing forwards it.
 */
export function captureSubmits(
    opts: { onSubmit?: (req: CapturedRequest, attempt: number) => Promise<Response | void> } = {},
): SubmitCapture {
    const requests: CapturedRequest[] = [];
    const capture: SubmitCapture = {
        requests,
        last() {
            const req = requests[requests.length - 1];
            if (!req) throw new Error(`captureSubmits: no submit seen (${requests.length} recorded)`);
            return req;
        },
        fetch: async (input, init) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!isSubmit(url, init?.method ?? "GET")) return fetch(input, init);
            const req = captured(url, init);
            requests.push(req);
            const answer = await opts.onSubmit?.(req, requests.length);
            return answer ?? (await fetch(input, init));
        },
    };
    return capture;
}

/**
 * Replay `req`, optionally with an edited body or a different idempotency key.
 *
 * The response is returned whatever its status: these tests are about which
 * refusal the relayer gives, so a non-2xx is the expected outcome rather than
 * an error.
 */
export async function replay(
    req: CapturedRequest,
    opts: { body?: string; idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<Response> {
    const headers = { ...req.headers };
    if (opts.idempotencyKey !== undefined) headers["idempotency-key"] = opts.idempotencyKey;
    return fetch(req.url, {
        method: req.method,
        headers,
        body: opts.body ?? req.body,
        // A refusal is immediate, so the default is the plain request budget. A
        // caller replaying a submission the relayer will actually run — one
        // held behind the batcher, say — has to raise it, or the answer it
        // means to assert on arrives after the abort.
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT.HTTP_MS),
    });
}

/**
 * `req`'s body with `mutate` applied to the parsed JSON.
 *
 * Mutating a copy rather than the captured request keeps one capture reusable
 * across a table of tampered cases.
 */
export function tampered(req: CapturedRequest, mutate: (body: Record<string, unknown>) => void): string {
    const body = req.json();
    mutate(body);
    return JSON.stringify(body);
}

/**
 * A submission's body, as far as a test needs to read or edit it.
 *
 * The fields are the ones `serializeSubmitTransact` writes
 * (`sdk/src/services/relayer/codec.ts`): decimal strings for field elements,
 * `0x` addresses, and the proof as the prover produced it. Narrowed at runtime
 * rather than cast, so a wire format that moves fails here, naming the field,
 * instead of surfacing as a tampered case the relayer accepts.
 */
export interface SubmitBody extends Record<string, unknown> {
    chainId: number;
    pubInputs: {
        nullifier: string[];
        outCm: string[];
        relayer: string;
        merkleRoot: string;
    } & Record<string, unknown>;
    /** snarkjs-shaped Groth16: `piA`/`piC` are G1, `piB` is G2. */
    proof: { piA: string[]; piB: string[][]; piC: string[] } & Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown, what: string): string[] {
    if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
        throw new Error(`submitBody: ${what} is not an array of strings`);
    }
    return v as string[];
}

/**
 * `req`'s body decoded as a spend submission.
 *
 * Use it to read a field a case asserts on, or to build a tampered copy:
 * `tampered(req, (b) => { asSubmit(b).pubInputs.relayer = other; })`.
 */
export function submitBody(req: CapturedRequest): SubmitBody {
    return asSubmit(req.json());
}

/** The same narrowing, for the mutable copy `tampered` hands its callback. */
export function asSubmit(body: Record<string, unknown>): SubmitBody {
    const { chainId, pubInputs, proof } = body;
    if (typeof chainId !== "number") throw new Error("submitBody: chainId is not a number");
    if (!isRecord(pubInputs)) throw new Error("submitBody: pubInputs is missing");
    if (!isRecord(proof)) throw new Error("submitBody: proof is missing");
    if (typeof pubInputs.relayer !== "string") throw new Error("submitBody: pubInputs.relayer is not a string");
    if (typeof pubInputs.merkleRoot !== "string") {
        throw new Error("submitBody: pubInputs.merkleRoot is not a string");
    }
    strings(pubInputs.nullifier, "pubInputs.nullifier");
    strings(pubInputs.outCm, "pubInputs.outCm");
    strings(proof.piA, "proof.piA");
    strings(proof.piC, "proof.piC");
    if (!Array.isArray(proof.piB)) throw new Error("submitBody: proof.piB is not an array");
    return body as SubmitBody;
}

/** What the relayer's signer has spent: gas leaves a trace in both. */
export interface SignerState {
    balanceWei: bigint;
    nonce: number;
}

/**
 * The relayer operator's account state.
 *
 * A refusal that costs the relayer nothing is the property the admission tests
 * are about: a submission it should reject before simulating must not move this
 * account. The signer is the Bundler's operator (`accounts.ts`), and every
 * relayer transaction is sent from it.
 */
export async function relayerSignerState(provider: ethers.Provider): Promise<SignerState> {
    const [balanceWei, nonce] = await Promise.all([
        provider.getBalance(RELAYER.address),
        provider.getTransactionCount(RELAYER.address, "latest"),
    ]);
    return { balanceWei, nonce };
}
