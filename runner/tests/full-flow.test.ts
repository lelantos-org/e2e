// E2E flow: deposit → shielded transfer → withdraw, all driven through the
// relayer + indexed by fmd-indexer + queryable via fmd-webserver. Tests
// share state across `it` blocks (fileParallelism=false in vitest.config.ts).

import { describe, it, expect, beforeAll } from "vitest";
import { ethers } from "ethers";

import {
    Poseidon,
    Jubjub,
    derivePk,
    MerkleTree,
    type Field,
    type Note,
} from "@lelantos/sdk";

import { env } from "../src/env";
import { pollUntil } from "../src/poll";
import { RelayerClient } from "../src/relayer-client";
import {
    buildDeposit,
    buildTransfer,
    buildWithdraw,
    emptyAux,
    ALICE_NSK,
    BOB_NSK,
    type SpendableCachedNote,
} from "../src/bundles";
import {
    makeWallet,
    encodeDetectionKeyHex,
    buildOutputAux,
    createSubscription,
    fetchMatches,
    syncBalance,
    makeCounterScalar,
    FMD_GAMMA,
    type Wallet,
} from "../src/wallet";

const MOCK_ERC20_ABI = [
    "function mint(address to, uint256 amount) public",
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function balanceOf(address) view returns (uint256)",
];

const MASP_ABI = [
    "function isKnownRoot(bytes32) view returns (bool)",
    "function currentRoot() view returns (bytes32)",
    "function committedCount() view returns (uint64)",
    "function spent(bytes32) view returns (bool)",
];

const DEPTH = 10;

describe("masp e2e flow", () => {
    let P: Poseidon;
    let J: Jubjub;
    let provider: ethers.JsonRpcProvider;
    let payer: ethers.Wallet;
    let relayer: RelayerClient;

    /// Local mirror of the on-chain merkle tree. Populated as we observe
    /// each tx's outputs land. Spend bundles read paths from this.
    let tree: MerkleTree;
    /// Alice's spendable notes (cached locally — same source the receiver
    /// would derive from FMD scan + ChaCha decrypt).
    let aliceWallet: SpendableCachedNote[];

    /// Bob — receives the shielded transfer. Subscribes to fmd-webserver
    /// before any tx so the indexer's filter has someone to match against.
    let bob: Wallet;
    let bobSubscriptionId: number;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        provider = new ethers.JsonRpcProvider(env.rpcUrl);
        payer = new ethers.Wallet(env.payerKey, provider);
        relayer = new RelayerClient(env.relayerUrl);
        tree = new MerkleTree(P, DEPTH);
        aliceWallet = [];

        // Mint enough for deposit + healthy balance for ERC20 inspection.
        const token = new ethers.Contract(env.token1, MOCK_ERC20_ABI, payer);
        await (await token.mint(env.payerAddress, 1000n)).wait();
        await (await token.approve(env.maspAddress, 1000n)).wait();

        await pollUntil(async () => {
            try { await relayer.health(); return true; } catch { return null; }
        }, { label: "relayer health", timeoutMs: 60_000 });

        // Bob's wallet + subscription. Uses a deterministic counter so test
        // re-runs are reproducible.
        bob = makeWallet(P, J, BOB_NSK, makeCounterScalar(0xb0bn));
        bobSubscriptionId = await createSubscription(
            encodeDetectionKeyHex(bob.detectionKey),
            FMD_GAMMA,
        );
    });

    async function pollNoteByCm(cmHex: string) {
        return pollUntil(async () => {
            const r = await fetch(`${env.fmdUrl}/v1/notes?chain_id=${env.chainId}&limit=20`);
            if (!r.ok) return null;
            const rows = (await r.json()) as Array<{ commitment_hex: string; leaf_index: number }>;
            return rows.find(n => "0x" + n.commitment_hex.toLowerCase() === cmHex.toLowerCase());
        }, { label: `fmd notes(${cmHex.slice(0, 12)})`, timeoutMs: 60_000 });
    }

    async function pollAdvance(startIndex: number) {
        return pollUntil(async () => {
            const r = await fetch(`${env.explorerUrl}/v1/tree-advances?chain_id=${env.chainId}&limit=20`);
            if (!r.ok) return null;
            const rows = (await r.json()) as Array<{
                start_index: number;
                inserted: number;
                new_root_hex: string;
            }>;
            return rows.find(t => t.start_index === startIndex);
        }, { label: `tree_advance(${startIndex})`, timeoutMs: 60_000 });
    }

    function recordOutputs(produced: [Note, Note], baseLeafIdx: number) {
        for (let i = 0; i < 2; i++) {
            tree.insert(BigInt(produced[i] as any).valueOf ? 0n : 0n);
            // Insert the actual cm — recompute from note.
        }
    }

    it("deposit: 100 units, alice gets a note", async () => {
        const startCount = await new ethers.Contract(env.maspAddress, MASP_ABI, provider).committedCount();
        expect(startCount).toBe(0n);

        const token = new ethers.Contract(env.token1, MOCK_ERC20_ABI, provider);
        const payerBefore = (await token.balanceOf(env.payerAddress)) as bigint;
        const maspBefore = (await token.balanceOf(env.maspAddress)) as bigint;

        const result = await buildDeposit(P, J, {
            publicIn: 100n,
            payerAddress: env.payerAddress,
            recipientAddress: env.recipientAddress,
        });
        const submit = await relayer.submitTransact(result.payload);
        expect(submit.tx_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

        // ERC20 movement: payer ↓ 100, MASP ↑ 100. publicOut=0 → recipient
        // gets nothing on chain.
        const payerAfter = (await token.balanceOf(env.payerAddress)) as bigint;
        const maspAfter = (await token.balanceOf(env.maspAddress)) as bigint;
        expect(payerBefore - payerAfter).toBe(100n);
        expect(maspAfter - maspBefore).toBe(100n);

        // Two cms land at leaves 0, 1.
        const note0 = await pollNoteByCm(result.cm0Hex);
        const note1 = await pollNoteByCm(result.cm1Hex);
        expect(note0.leaf_index).toBe(0);
        expect(note1.leaf_index).toBe(1);

        const adv = await pollAdvance(0);
        expect(adv.inserted).toBe(2);

        // Update local tree mirror in the same order the contract does.
        const { buildNoteCommitment } = await import("@lelantos/sdk");
        tree.insert(buildNoteCommitment(P, result.producedNotes[0]));
        tree.insert(buildNoteCommitment(P, result.producedNotes[1]));

        // Cache alice's spendable note (the real value=100 output).
        aliceWallet.push({
            note: result.producedNotes[0],
            nsk: ALICE_NSK,
            leafIndex: note0.leaf_index,
        });

        // Path round-trip
        const pathRes = await fetch(`${env.fmdUrl}/v1/path/${result.cm0Hex}?chain_id=${env.chainId}`);
        expect(pathRes.ok).toBe(true);
        const path = (await pathRes.json()) as { root_hex: string };
        const masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
        expect(await masp.isKnownRoot(path.root_hex)).toBe(true);
        expect(await masp.committedCount()).toBe(2n);
    });

    it("shielded transfer: alice sends 60 to bob, keeps 40 change", async () => {
        const aliceCached = aliceWallet[0];
        const aliceP = derivePk(P, ALICE_NSK);
        const bobP = derivePk(P, BOB_NSK);

        const bobOut: Note = { asset: 1n, value: 60n, pk: bobP, rho: 50n, rcm: 51n, rcv: 52n };
        const aliceChange: Note = { asset: 1n, value: 40n, pk: aliceP, rho: 53n, rcm: 54n, rcv: 55n };

        const token = new ethers.Contract(env.token1, MOCK_ERC20_ABI, provider);
        const payerBefore = (await token.balanceOf(env.payerAddress)) as bigint;
        const maspBefore = (await token.balanceOf(env.maspAddress)) as bigint;
        const recipientBefore = (await token.balanceOf(env.recipientAddress)) as bigint;

        // Wrap bob's output in a real FMD clue + encrypted ciphertext so the
        // fmd-indexer matches it against bob's subscription. Alice's change
        // output uses an empty aux (she doesn't need to discover her own
        // notes via FMD — wallet retains them locally).
        const fmdR = makeCounterScalar(0xfacecafe1234n)();
        const esk = makeCounterScalar(0xe0a5e0a5e0a5n)();
        const bobAux = buildOutputAux({
            J,
            recipientFlagKey: bob.flagKey,
            recipientPkD: bob.keys.pk_d,
            fmdR,
            esk,
            note: bobOut,
        });

        const oldRoot = tree.root();
        const result = await buildTransfer(P, J, {
            cached: aliceCached,
            tree,
            merkleRoot: oldRoot,
            outputs: [bobOut, aliceChange],
            payerAddress: env.payerAddress,
            recipientAddress: env.recipientAddress,
            aux: [bobAux, emptyAux],
        });

        const submit = await relayer.submitTransact(result.payload);
        expect(submit.tx_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

        // Shielded transfer: zero ERC20 movement on every party.
        const payerAfter = (await token.balanceOf(env.payerAddress)) as bigint;
        const maspAfter = (await token.balanceOf(env.maspAddress)) as bigint;
        const recipientAfter = (await token.balanceOf(env.recipientAddress)) as bigint;
        expect(payerAfter).toBe(payerBefore);
        expect(maspAfter).toBe(maspBefore);
        expect(recipientAfter).toBe(recipientBefore);

        const note0 = await pollNoteByCm(result.cm0Hex);
        const note1 = await pollNoteByCm(result.cm1Hex);
        expect(note0.leaf_index).toBe(2);
        expect(note1.leaf_index).toBe(3);

        const adv = await pollAdvance(2);
        expect(adv.inserted).toBe(2);

        // Update mirror; track alice's change note as her new spendable.
        const { buildNoteCommitment, buildNullifier } = await import("@lelantos/sdk");
        tree.insert(buildNoteCommitment(P, bobOut));
        tree.insert(buildNoteCommitment(P, aliceChange));
        aliceWallet = [{ note: aliceChange, nsk: ALICE_NSK, leafIndex: note1.leaf_index }];

        // Confirm alice's spent nullifier registered.
        const spentNf = buildNullifier(P, ALICE_NSK, aliceCached.note.rho);
        const masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
        const nfHex = "0x" + spentNf.toString(16).padStart(64, "0");
        expect(await masp.spent(nfHex)).toBe(true);
        expect(await masp.committedCount()).toBe(4n);
    });

    it("withdraw: alice unshields 40 to a public address", async () => {
        const aliceCached = aliceWallet[0];
        expect(aliceCached.note.value).toBe(40n);

        const aliceP = derivePk(P, ALICE_NSK);
        const pad0: Note = { asset: 1n, value: 0n, pk: aliceP, rho: 60n, rcm: 61n, rcv: 62n };
        const pad1: Note = { asset: 1n, value: 0n, pk: aliceP, rho: 63n, rcm: 64n, rcv: 65n };

        const token = new ethers.Contract(env.token1, MOCK_ERC20_ABI, provider);
        const payerBefore = (await token.balanceOf(env.payerAddress)) as bigint;
        const maspBefore = (await token.balanceOf(env.maspAddress)) as bigint;
        const recipientBefore = (await token.balanceOf(env.recipientAddress)) as bigint;

        const oldRoot = tree.root();
        const result = await buildWithdraw(P, J, {
            cached: aliceCached,
            tree,
            merkleRoot: oldRoot,
            publicOut: 40n,
            change: [pad0, pad1],
            payerAddress: env.payerAddress,
            recipientAddress: env.recipientAddress,
        });

        const submit = await relayer.submitTransact(result.payload);
        expect(submit.tx_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

        const adv = await pollAdvance(4);
        expect(adv.inserted).toBe(2);

        // ERC20 movement: payer unchanged (no transferFrom on withdraw),
        // MASP ↓ 40 (transfers out), recipient ↑ 40.
        const payerAfter = (await token.balanceOf(env.payerAddress)) as bigint;
        const maspAfter = (await token.balanceOf(env.maspAddress)) as bigint;
        const recipientAfter = (await token.balanceOf(env.recipientAddress)) as bigint;
        expect(payerAfter).toBe(payerBefore);
        expect(maspBefore - maspAfter).toBe(40n);
        expect(recipientAfter - recipientBefore).toBe(40n);

        const masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
        expect(await masp.committedCount()).toBe(6n);
    });

    it("client sync: bob recovers his 60-unit balance via fmd-webserver", async () => {
        // Bob's filter task should have matched exactly one note (his 60
        // share from the shielded transfer). The other notes (alice's
        // deposit, alice's change, alice's two padding withdraw outputs)
        // carry empty aux → never match bob's detection key.
        const matches = await pollUntil(async () => {
            const ms = await fetchMatches(bobSubscriptionId);
            return ms.length >= 1 ? ms : null;
        }, { label: "bob matches", timeoutMs: 60_000 });

        expect(matches.length).toBe(1);
        const m = matches[0];
        expect(m.leaf_index).toBe(2); // bob's slot in the transfer (cm0)

        // Decrypt with bob's ivk; reconstruct plaintext.
        const sync = syncBalance(J, bob.keys.ivk, matches, 1n);
        expect(sync.decrypted.length).toBe(1);
        expect(sync.decrypted[0].asset).toBe(1n);
        expect(sync.decrypted[0].value).toBe(60n);
        expect(sync.balance).toBe(60n);
    });
});
