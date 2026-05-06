// E2E: cold-client recovery via fmd-webserver.
//
// Models the realistic wallet-restart path. Bob registers his detection
// key once, then walks away. Activity happens (two deposits + two
// transfers, mixing notes for Bob and for Alice). A fresh FmdClient
// instance later reconnects with only Bob's spending key + the
// subscription id, and must rebuild Bob's full shielded balance from
// scratch using:
//   - listMatches  — all clues that hit Bob's detection key
//   - decryptNote  — recover plaintext payload via Bob's ivk
//   - fetchPath    — confirm each match is spendable (in-tree)
//   - cm recomputation — ensure each recovered note's commitment matches
//     what the indexer has on file (no impostor / decoy slipped through)
//
// The full-flow test exercises a single Bob match. This one validates
// the same path under multiple matches across multiple txs, and
// explicitly through a cold FmdClient (no in-memory state carried over).

import { ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import {
    buildTransfer,
    detectionKeyToHex,
    FmdClient,
    Jubjub,
    type Note,
    Poseidon,
    RelayerClient,
    type SpendableCachedNote,
} from "@lelantos-org/sdk";

import { env } from "../src/env";
import {
    ASSET,
    cmToHex,
    counter,
    inputSlotFor,
    makeWallet,
    noteFor,
    rngForOutput,
    setupErc20,
    type TestWallet,
    waitForCm,
} from "../src/scenario";
import { pollUntil } from "../src/utils";
import {
    currentRoot,
    decryptAndVerifyMatch,
    depositToWallet,
    makeBundleCommon,
    newAuxRng,
    waitForFmdHealth,
} from "./_shared";

const ALICE_NSK = 11n;
const BOB_NSK = 22n;
const DEPOSIT_1 = 100n;
const DEPOSIT_2 = 50n;
const TO_BOB_1 = 30n;
const TO_BOB_2 = 20n;
const EXPECTED_BOB_TOTAL = TO_BOB_1 + TO_BOB_2;

describe("cold-client resync", () => {
    let P: Poseidon;
    let J: Jubjub;
    let relayer: RelayerClient;
    /// "Online" client used while activity is generated.
    let fmd: FmdClient;
    let alice: TestWallet;
    let bob: TestWallet;
    let bobSubscriptionId: number;
    let aliceSpendable: SpendableCachedNote;

    const aliceRng = counter(0xc01dn);
    const bobRng = counter(0xb0bbn);
    const auxRng = newAuxRng();

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        const provider = new ethers.JsonRpcProvider(env.rpcUrl);
        const payer = new ethers.Wallet(env.payerKey, provider);
        relayer = new RelayerClient(env.relayerUrl);
        fmd = new FmdClient(env.fmdUrl, env.chainId);
        await setupErc20(payer, env.token2, env.maspAddress, DEPOSIT_1 + DEPOSIT_2);

        await waitForFmdHealth();

        alice = makeWallet(P, J, ALICE_NSK);
        bob = makeWallet(P, J, BOB_NSK);

        // Bob registers his detection key once. Subscription persists on
        // the server side; the cold client later just reuses the id.
        const sub = await fmd.createSubscription({
            detectionKeyHex: detectionKeyToHex(bob.detectionKey),
            gamma: bob.detectionKey.x.length,
        });
        bobSubscriptionId = sub.id;
    });

    it("activity sequence: 2 deposits + 2 transfers to bob", async () => {
        // Deposit 1 — alice gets a 100-note.
        aliceSpendable = await depositToWallet({
            P, J, relayer, fmd, wallet: alice, nsk: ALICE_NSK,
            amount: DEPOSIT_1, rng: aliceRng, auxRng,
        });

        // Transfer 1 — 30 to bob, 70 change to alice.
        const bobOut1: Note = noteFor(bob, TO_BOB_1, bobRng);
        const aliceChange1: Note = noteFor(alice, DEPOSIT_1 - TO_BOB_1, aliceRng);
        const t1 = await buildTransfer({
            ...makeBundleCommon(P, J),
            inputs: [await inputSlotFor(P, fmd, aliceSpendable), null],
            merkleRoot: await currentRoot(fmd),
            outputs: [bobOut1, aliceChange1],
            outputRecipients: [bob.recipient, alice.recipient],
            outputRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });
        await relayer.submitTransact(t1.payload);
        await waitForCm(fmd, t1.cm[0]);
        const change1Indexed = await waitForCm(fmd, t1.cm[1]);
        aliceSpendable = { note: aliceChange1, nsk: ALICE_NSK, leafIndex: change1Indexed.leafIndex };

        // Deposit 2 — alice gets another spendable note (50).
        aliceSpendable = await depositToWallet({
            P, J, relayer, fmd, wallet: alice, nsk: ALICE_NSK,
            amount: DEPOSIT_2, rng: aliceRng, auxRng,
        });

        // Transfer 2 — 20 to bob, 30 change to alice. Spends the 50-note.
        const bobOut2: Note = noteFor(bob, TO_BOB_2, bobRng);
        const aliceChange2: Note = noteFor(alice, DEPOSIT_2 - TO_BOB_2, aliceRng);
        const t2 = await buildTransfer({
            ...makeBundleCommon(P, J),
            inputs: [await inputSlotFor(P, fmd, aliceSpendable), null],
            merkleRoot: await currentRoot(fmd),
            outputs: [bobOut2, aliceChange2],
            outputRecipients: [bob.recipient, alice.recipient],
            outputRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
        });
        await relayer.submitTransact(t2.payload);
        await waitForCm(fmd, t2.cm[0]);
        await waitForCm(fmd, t2.cm[1]);
    });

    it("fresh FmdClient reconstructs bob's balance from scratch", async () => {
        // Brand-new client — no shared state with the producer above.
        const cold = new FmdClient(env.fmdUrl, env.chainId);

        // Wait until both bob clues have been matched server-side.
        const matches = await pollUntil(
            async () => {
                const ms = await cold.listMatches({
                    subscription: bobSubscriptionId,
                    limit: 100,
                });
                return ms.length >= 2 ? ms : null;
            },
            { label: "bob matches (cold)", timeoutMs: 60_000 },
        );

        // Exactly the two transfer-to-bob outputs — alice's notes/pads
        // must not bleed into bob's match set.
        expect(matches.length).toBe(2);

        let recoveredTotal = 0n;
        for (const m of matches) {
            const { payload, cm } = await decryptAndVerifyMatch(P, J, bob, m);
            expect(payload.asset).toBe(ASSET);

            // Spendability check — wallet would need a path to spend.
            const path = await cold.fetchPath(cmToHex(cm));
            expect(path.leafIndex).toBe(m.leafIndex);

            recoveredTotal += payload.value;
        }

        expect(recoveredTotal).toBe(EXPECTED_BOB_TOTAL);
    });
});
