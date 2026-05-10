// E2E: cold-client recovery via fmd-webserver.
//
// Bob registers his detection key, then walks away. Activity happens
// (two deposits + two transfers, mixing notes for Bob and for Alice). A
// fresh `FmdClient` later reconnects with only Bob's spending key + the
// subscription id, and rebuilds Bob's full shielded balance via
// listMatches → decryptNote → fetchPath → cm recomputation.

import { FmdClient } from "@lelantos-org/sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "../src/env";
import {
    type Actor,
    ASSET,
    cmToHex,
    counter,
    decryptAndVerifyMatch,
    deposit,
    filterRealMatches,
    type Harness,
    newAuxRng,
    type Note,
    noteFor,
    pollUntil,
    setupActors,
    setupHarness,
    type SpendableCachedNote,
    submitTransfer,
    withFee,
} from "../src/harness";

// Test-local actor seeds. Each e2e file picks unique nsks because
// `fmd_webserver.subscriptions` enforces UNIQUE(detection_key) and the
// detection key is deterministic from nsk — sharing nsks across files
// makes the second `createSubscription` collide with the first.
const ALICE_NSK = 0xcc_a1ce_a11c0n;
const BOB_NSK = 0xcc_b0b_b0b00n;
const DEPOSIT_1 = 100n;
const DEPOSIT_2 = 50n;
const TO_BOB_1 = 30n;
const TO_BOB_2 = 20n;
const EXPECTED_BOB_TOTAL = TO_BOB_1 + TO_BOB_2;

describe("cold-client resync", () => {
    let h: Harness;
    let alice: Actor;
    let bob: Actor;
    let aliceSpendable: SpendableCachedNote;

    const aliceRng = counter(0xcc_a1ce_0001n);
    const bobRng = counter(0xcc_b0b_0001n);
    const auxRng = newAuxRng(0xcc_add_0001n);

    beforeAll(async () => {
        h = await setupHarness({
            fund: [{ kind: "erc20", token: env.token2, amount: withFee(DEPOSIT_1 + DEPOSIT_2) }],
        });
        ({ alice, bob } = await setupActors(h, {
            alice: { nsk: ALICE_NSK },
            bob: { nsk: BOB_NSK, subscribe: true },
        }));
    });

    it("activity sequence: 2 deposits + 2 transfers to bob", async () => {
        // Deposit 1 — alice gets a 100-note.
        aliceSpendable = await deposit({
            h, wallet: alice, nsk: ALICE_NSK, amount: DEPOSIT_1, rng: aliceRng, auxRng,
        });

        // Transfer 1 — 30 to bob, 70 change to alice.
        const bobOut1: Note = noteFor(bob, TO_BOB_1, bobRng);
        const aliceChange1: Note = noteFor(alice, DEPOSIT_1 - TO_BOB_1, aliceRng);
        const t1 = await submitTransfer({
            h,
            inputs: [aliceSpendable],
            outputs: [bobOut1, aliceChange1],
            recipients: [bob, alice],
            auxRng,
        });
        // Refetch the change leaf via fmd so subsequent inputSlotFor
        // calls hit the right index.
        const change1Leaf = (await h.fmd.fetchPath(cmToHex(t1.cm[1]))).leafIndex;
        aliceSpendable = { note: aliceChange1, nsk: ALICE_NSK, leafIndex: change1Leaf };

        // Deposit 2 — alice gets another spendable note (50).
        aliceSpendable = await deposit({
            h, wallet: alice, nsk: ALICE_NSK, amount: DEPOSIT_2, rng: aliceRng, auxRng,
        });

        // Transfer 2 — 20 to bob, 30 change to alice. Spends the 50-note.
        const bobOut2: Note = noteFor(bob, TO_BOB_2, bobRng);
        const aliceChange2: Note = noteFor(alice, DEPOSIT_2 - TO_BOB_2, aliceRng);
        await submitTransfer({
            h,
            inputs: [aliceSpendable],
            outputs: [bobOut2, aliceChange2],
            recipients: [bob, alice],
            auxRng,
        });
    });

    it("fresh FmdClient reconstructs bob's balance from scratch", async () => {
        // Brand-new client — no shared state with the producer above.
        const cold = new FmdClient(env.fmdUrl, env.chainId);

        // FMD γ=5 ⇒ ~1/32 false-positive rate; raw listMatches can include
        // decoys from alice's outputs. Decryption with bob's ivk drops them.
        const matches = await pollUntil(
            async () => {
                const ms = await cold.listMatches({
                    subscription: bob.subscriptionId!,
                    limit: 100,
                });
                const r = filterRealMatches(h.P, h.J, bob, ms);
                return r.length >= 2 ? r : null;
            },
            { label: "bob matches (cold)", timeoutMs: 60_000 },
        );

        // Exactly the two transfer-to-bob outputs — alice's notes/pads
        // must not bleed into bob's match set.
        expect(matches.length).toBe(2);

        let recoveredTotal = 0n;
        for (const m of matches) {
            const { payload, cm } = await decryptAndVerifyMatch(h.P, h.J, bob, m);
            expect(payload.asset).toBe(ASSET);
            const path = await cold.fetchPath(cmToHex(cm));
            expect(path.leafIndex).toBe(m.leafIndex);
            recoveredTotal += payload.value;
        }
        expect(recoveredTotal).toBe(EXPECTED_BOB_TOTAL);
    });
});
