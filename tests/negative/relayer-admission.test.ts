// What a malformed submission costs the relayer: nothing.
//
// The relayer pays the gas for every operation it lands, so admission is the
// only thing standing between it and an attacker who submits garbage all day.
// Its pipeline is ordered for exactly that — parse, bind, verify the SNARK
// locally, charge the fee, and only then enqueue for a bundle that is dry-run
// and simulated before it is ever signed (`pipeline/spend/mod.rs`,
// `services/submitter.rs`: "Everything here happened before the transaction was
// signed, so nothing reached the mempool"). Every case here is a submission that
// must die somewhere in that prefix.
//
// The property each case shares, and the reason this file exists, is not the
// status code but what did *not* happen: the relayer's signer has the same
// balance and the same nonce afterwards, and its batcher gained no operation.
// A status assertion alone would still pass a relayer that refused the payload
// after simulating it, or after broadcasting and reverting.
//
// The payload is a real one. A wallet is built with a `fetch` that records the
// submit and answers it itself, so the relayer never sees the original: its
// nullifiers stay unspent, and every tampered copy therefore reaches the check
// it is about rather than being turned away at the nullifier guard, which runs
// first (`handlers/http/submit.rs`, `services/admission/nullifier_guard.rs`).
// Re-encoding a payload here instead would make the wire format a second source
// of truth — see `src/testkit/raw-relayer.ts`.
//
// Every replay carries a fresh `Idempotency-Key`. The captured key never
// reached the relayer — the capture answered that attempt locally — so reusing
// it would work today; a fresh one keeps each case independent of that, since a
// key answered by an earlier case is replayed from the cache, or refused as
// reused against a different fingerprint, for reasons that have nothing to do
// with the field under test.
//
// The whole table runs with the batcher held, so `queue()` is a live view: an
// operation that got past admission would be sitting in it rather than already
// dispatched, and the held batcher also pins the signer's nonce for the
// duration. A hold is chain-wide, so `afterAll` releases it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BN254_FR } from "@lelantos-org/sdk/primitives";

import { RELAYER } from "../../src/accounts.js";
import { env } from "../../src/env.js";
import {
    amt,
    ASSET,
    awaitOwn,
    asSubmit,
    type CapturedRequest,
    captureSubmits,
    createTestWallet,
    DEAD_ADDRESS,
    expectRevert,
    FEE_HEADROOM,
    type Harness,
    type QueuedOp,
    RelayerHooks,
    relayerSignerState,
    replay,
    type SignerState,
    tampered,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../../src/harness.js";
import { setupFile, type SdkWallet } from "../../src/fixture.js";
import { settleNonce } from "../../src/tx.js";

const NSK = TEST_NSK.relayerAdmission;

/** The one deposit this file makes, in circuit units, and what the capture spends. */
const DEPOSIT = 40n;
const SEND = 10n;

/**
 * What the capturing transport answers the wallet with, so the submit never
 * leaves the process.
 *
 * A 400 rather than a 503: the SDK retries a submit only where the relayer
 * cannot have acted (no response, 429, 503), so a 400 is answered once and
 * leaves the spend's notes untouched (`classifySubmitFailure` in
 * `sdk/src/wallet/tx/steps.ts`). The text is shaped like the relayer's own
 * `bad request: ` refusal so the SDK classifies it without guessing.
 */
const CAPTURED = "bad request: captured by the test; never sent to the relayer";

/**
 * A chain id this stack does not serve.
 *
 * `chainId` travels in the body, not the path: the relayer mounts `/v1/spend`
 * with no chain segment (`handlers/http/router.rs`) and resolves the per-chain
 * pipeline from the field.
 */
const UNSERVED_CHAIN_ID = 987_654;

/** `DefaultBodyLimit::max(MAX_BODY_BYTES)`, `handlers/http/router.rs`. */
const MAX_BODY_BYTES = 256 * 1024;

// --- the table ------------------------------------------------------------------------------------

interface AdmissionCase {
    name: string;
    /** The body to send, built from the captured one. */
    body: (req: CapturedRequest) => string;
    status: number;
    /**
     * The relayer's refusal, verbatim. Plain text, not JSON: it renders
     * `(status, client_message)` (`domain/error.rs`), and the prefixes are the
     * `AppError` variants' own `Display`. The same strings are pinned SDK-side
     * in `sdk/src/services/relayer/reject-reason.ts`.
     *
     * Absent where the answer comes from axum's extractors rather than the
     * relayer, so the text is not the relayer's to keep stable.
     */
    match?: RegExp;
}

const CASES: AdmissionCase[] = [
    {
        // `st.spend_pipeline(payload.chain_id)?` is the handler's first
        // statement, so this is refused before the body is even looked at.
        name: "a chain the relayer does not serve",
        body: (req) => tampered(req, (b) => {
            b.chainId = UNSERVED_CHAIN_ID;
        }),
        status: 404,
        match: new RegExp(`^unknown chain: ${UNSERVED_CHAIN_ID}$`),
    },
    {
        // The binding that stops one relayer's proof being spent through
        // another's Bundler, checked before the SNARK is verified
        // (`pipeline/transact/mod.rs`). `tests/bundler-mixed` covers the
        // on-chain half of the same guard, `MASP.BadRelayer`.
        name: "a proof bound to another relayer",
        body: (req) => tampered(req, (b) => {
            asSubmit(b).pubInputs.relayer = DEAD_ADDRESS;
        }),
        status: 400,
        match: /^bad request: pubInputs\.relayer \(.+\) must equal the expected relayer \(.+\)$/,
    },
    {
        // The pool's `NullifierSet.DuplicateNullifier` would catch this on
        // chain, at the relayer's expense. The nullifier guard tolerates the
        // repeat — it tests membership against the pre-existing in-flight set
        // and inserts into a `HashSet` — so the request reaches the pairwise
        // check in `pipeline/transact/mod.rs`, which names the first pair.
        name: "one nullifier submitted twice in the same payload",
        body: (req) => tampered(req, (b) => {
            const pi = asSubmit(b).pubInputs;
            pi.nullifier[1] = pi.nullifier[0];
        }),
        status: 400,
        match: /^bad request: nullifiers 0 and 1 are equal; all must differ$/,
    },
    {
        // Refused by `nullifiers_of` in the handler, before the idempotency key
        // is read: a value at or above the BN254 scalar modulus is not a field
        // element, and accepting one would let a submission address a slot the
        // circuit cannot reach.
        name: "a field element at the BN254 modulus",
        body: (req) => tampered(req, (b) => {
            asSubmit(b).pubInputs.nullifier[0] = BN254_FR.toString();
        }),
        status: 400,
        match: /^bad request: pubInputs\.nullifier\[0\] is not a canonical field element \(must be below the BN254 scalar modulus\)$/,
    },
    {
        // `piC := piA` rather than a flipped digit: both are G1 points, so the
        // copy is a canonical base-field pair that deserialises cleanly and
        // fails at the pairing check, which is the guard this case is about. A
        // mutated digit could instead land above the base-field modulus and be
        // refused one step earlier, by the coordinate parser.
        //
        // Reachable only because this stack loads a transact verification key
        // (`transact_vkey_path` in `config/relayer.toml`); without one the
        // relayer skips local verification and a bad proof is caught later, at
        // the pool's expense in simulation rather than the prover's.
        name: "a proof that does not verify against its public inputs",
        body: (req) => tampered(req, (b) => {
            const p = asSubmit(b).proof;
            p.piC.splice(0, p.piC.length, ...p.piA);
        }),
        status: 400,
        match: /^bad request: proof does not verify against its public inputs$/,
    },
    {
        // Refused by the body-limit layer before anything is parsed, so the
        // padding need only be large; an unknown key is the cheapest way to add
        // it without disturbing a field the relayer reads. The answer is axum's
        // own rejection text, not the relayer's, so only the status is pinned.
        name: "a body over the 256 KB limit",
        body: (req) => tampered(req, (b) => {
            b.padding = "x".repeat(MAX_BODY_BYTES);
        }),
        status: 413,
    },
];

// --- the file -------------------------------------------------------------------------------------

describe("negative: the relayer refuses a malformed submission before it spends gas", () => {
    let h: Harness;
    let hooks: RelayerHooks;
    /** One real, proven, never-submitted spend. Every case tampers with a copy of it. */
    let captured: CapturedRequest;
    let signerBefore: SignerState;
    let queueBefore: QueuedOp[];

    /** Fresh per replay; see the file header. Well under the relayer's 128-char cap. */
    let keySeq = 0;
    const freshKey = (): string => `e2e-admission-${Date.now().toString(16)}-${keySeq++}`;

    beforeAll(async () => {
        let bob: SdkWallet;
        // Only bob comes from the fixture: alice needs the capturing transport,
        // which `setupFile` does not pass through.
        ({ h, w: { bob } } = await setupFile({
            nsks: { bob: NSK.bob },
            fund: [{ asset: ASSET, amount: withFee(DEPOSIT + FEE_HEADROOM) }],
        }));
        hooks = new RelayerHooks(env.relayerUrl, env.chainId);
        // A hold left by an earlier run against a kept-alive stack would stall
        // the funding deposit below.
        await hooks.release();

        const capture = captureSubmits({
            onSubmit: async () => new Response(CAPTURED, { status: 400 }),
        });
        const alice = await createTestWallet(NSK.alice, { fetch: capture.fetch });
        const d = await alice.deposit({ amount: amt(DEPOSIT), asset: ASSET });
        await awaitOwn(alice, d);

        // The spend is proved for real and refused on the wire, so the payload
        // is one the relayer would have accepted and its nullifiers are unspent.
        await expectRevert(
            alice.transfer({ recipient: bob.address, amount: amt(SEND), asset: ASSET }),
            { code: "RELAYER_REJECTED", match: CAPTURED },
        );
        captured = capture.last();
        expect(captured.idempotencyKey, "a submit always carries a key").toBeTypeOf("string");

        // Held first, then snapshotted: with the batcher held nothing is
        // dispatched, so the signer cannot move for reasons of its own while the
        // table runs. `settleNonce` waits out whatever the deposit's flush left
        // in the mempool, so the nonce read below is the settled one.
        await hooks.hold();
        await settleNonce(h.provider, RELAYER.address);
        signerBefore = await relayerSignerState(h.provider);
        queueBefore = await hooks.queue();
    }, TEST_TIMEOUT.SEQUENCE);

    afterAll(async () => {
        await hooks.release();
    });

    it.each(CASES)("refuses $name", async ({ body, status, match }) => {
        const res = await replay(captured, { body: body(captured), idempotencyKey: freshKey() });
        const text = await res.text();
        expect(res.status, `refused with: ${text}`).toBe(status);
        if (match !== undefined) expect(text.trim()).toMatch(match);
    }, TEST_TIMEOUT.LOCAL);

    it.todo(
        "refuses a spend whose shielded fee note is missing or short — unreachable from the client: " +
            "the fee is charged after the proof is verified over `aux`, and the fee note lives in " +
            "`aux`, so any tamper that removes or shrinks it is refused as a bad proof first. Needs " +
            "an SDK knob to build a spend with an underpaid fee note.",
    );

    it.todo(
        "refuses a withdrawNative on a chain with no native adapter — unreachable on this stack: " +
            "it deploys one and the relayer is configured with it (NATIVE_ADAPTER_ADDRESS), so " +
            "`bad request: withdrawNative is not available on this chain` cannot be provoked from a " +
            "client. `tests/withdraw-native` covers the adapter being present instead.",
    );

    it("costs the relayer neither gas nor a queue slot", async () => {
        // The point of the file. Read after the table above, which vitest runs
        // in declaration order, and while the batcher is still held.
        expect(await relayerSignerState(h.provider), "the relayer's signer never moved").toEqual(
            signerBefore,
        );
        expect(await hooks.queue(), "no refused submission reached the batcher").toEqual(queueBefore);
    }, TEST_TIMEOUT.LOCAL);
});
