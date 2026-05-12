// Test harness: one-call setup for the boilerplate every e2e file shared
// (Poseidon/Jubjub build, ethers wiring, RelayerClient, FmdClient, actor
// derivation, ERC20/WETH funding) plus the higher-level submit recipes
// that wrap the buildTransfer/buildWithdraw + relayer + waitForCm cycle.
//
// Tests pull their state from `Harness` instead of redeclaring it in
// every `beforeAll`.

import { ethers } from "ethers";

import {
    type AuxOutput,
    buildDeposit,
    buildNoteCommitment,
    buildTransfer,
    buildWithdraw,
    buildWithdrawNative,
    computePiHash,
    decodeNotePayload,
    decryptNote,
    type DepositIntent,
    detectionKeyToHex,
    type Field,
    type FmdMatchOut,
    FmdClient,
    Jubjub,
    type Note,
    type NotePayload,
    Poseidon,
    RelayerClient,
    signPermit2Witness,
    type SpendableCachedNote,
    stripClueBitsPrefix,
} from "@lelantos-org/sdk";

import { RELAYER } from "./accounts";
import { ASSET, MASP_ABI, TIMEOUT, TREE_DEPTH, withFee } from "./constants";
import { env } from "./env";
import {
    type Erc20Helpers,
    inputSlotFor,
    makeWallet,
    noteFor,
    rngForOutput,
    setupErc20,
    setupWeth,
    type TestWallet,
    waitForCm,
} from "./scenario";
import { cmToHex, counter, hexToBytes, pollUntil } from "./utils";

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

export const PROVER_PATHS = {
    wasmPath: require.resolve("@lelantos-org/circuits/2x2/2x2.wasm"),
    zkeyPath: require.resolve("@lelantos-org/circuits/2x2/2x2_final.zkey"),
};

/// Default aux-randomness seed. Test files SHOULD pass a file-unique seed
/// (e.g. `newAuxRng(SEEDS.deposit.aux)`) — sharing the same seed across
/// files makes their derived FMD clues + ECDH ephemeral keys collide
/// when they touch overlapping wallets/values, which on a shared anvil
/// can produce identical output commitments and break later submissions.
export const AUX_RNG_SEED = 0xfacecafen;
export const newAuxRng = (seed: bigint = AUX_RNG_SEED) => counter(seed);

// ──────────────────────────────────────────────────────────────────────
// Harness
// ──────────────────────────────────────────────────────────────────────

export interface Harness {
    P: Poseidon;
    J: Jubjub;
    provider: ethers.JsonRpcProvider;
    payer: ethers.NonceManager;
    masp: ethers.Contract;
    relayer: RelayerClient;
    fmd: FmdClient;
    /// Bundle-builder common fields (everything except per-call args).
    bundleCommon(asset?: bigint): {
        P: Poseidon;
        J: Jubjub;
        chainId: bigint;
        asset: bigint;
        payerAddress: string;
        relayerAddress: string;
        recipientAddress: string;
        proverPaths: typeof PROVER_PATHS;
        treeDepth: number;
    };
    /// Current commitment-tree root (per fmd-webserver).
    currentRoot(): Promise<Field>;
}

export interface SetupOpts {
    /// Tokens to fund the payer with (ERC20: setupErc20, WETH: setupWeth).
    /// `spender` is fixed to the canonical Permit2 address.
    fund?: { kind: "erc20" | "weth"; token: string; amount: bigint }[];
}

/// Build everything that every e2e file's `beforeAll` used to assemble.
/// Funds the payer + waits for fmd-webserver health before returning.
export async function setupHarness(opts: SetupOpts = {}): Promise<Harness> {
    const P = await Poseidon.build();
    const J = await Jubjub.build();
    const provider = new ethers.JsonRpcProvider(env.rpcUrl);
    // PAYER is a deterministic EOA shared across every test file (its
    // private key is hardcoded in `accounts.ts`). Vitest reuses one
    // anvil for the whole run, so by file N the chain has already
    // accepted txs from setup phases 1..N-1. CI hit `NONCE_EXPIRED` on
    // the first `approve(Permit2)` because anvil's mempool still
    // carried unmined inflight txs from the previous file when this
    // one read `getTransactionCount("pending")`. Force-mine 2 blocks
    // up front so the mempool is empty before any new ethers call
    // queries the nonce.
    await flushMempool(provider);
    // NonceManager tracks nonce locally so back-to-back sends (mint→approve
    // in setupErc20, etc.) don't race anvil's `pending` counter, which can
    // briefly lag after `.wait()` returns and hand ethers a just-mined nonce.
    const payer = new ethers.NonceManager(new ethers.Wallet(env.payerKey, provider));
    const masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
    const relayer = new RelayerClient(env.relayerUrl);
    const fmd = new FmdClient(env.fmdUrl, env.chainId);

    for (const f of opts.fund ?? []) {
        if (f.kind === "weth") await setupWeth(payer, f.token, env.permit2Address, f.amount);
        else await setupErc20(payer, f.token, env.permit2Address, f.amount);
    }

    await waitForFmdHealth();

    return {
        P,
        J,
        provider,
        payer,
        masp,
        relayer,
        fmd,
        bundleCommon: (asset = ASSET) => ({
            P,
            J,
            chainId: env.chainId,
            asset,
            payerAddress: env.payerAddress,
            relayerAddress: RELAYER.address,
            recipientAddress: env.recipientAddress,
            proverPaths: PROVER_PATHS,
            treeDepth: TREE_DEPTH,
        }),
        currentRoot: async () => (await fmd.fetchTreeState()).root,
    };
}

/// Mine pending blocks on the dev anvil so the mempool is empty before
/// the caller queries `getTransactionCount`. Without this, ethers can
/// see inflight txs from the previous test file's setup and hand the
/// chain a nonce that gets stamped before the prior block lands —
/// raising NONCE_EXPIRED on the next send. Quietly no-ops on chains
/// that don't expose `anvil_mine`.
async function flushMempool(provider: ethers.JsonRpcProvider): Promise<void> {
    try {
        await provider.send("anvil_mine", ["0x2"]);
    } catch {
        // not anvil — nothing to do
    }
}

export async function waitForFmdHealth(): Promise<void> {
    await pollUntil(
        async () => {
            const r = await fetch(env.fmdUrl + "/health").catch(() => null);
            return r?.ok ? true : null;
        },
        { label: "fmd health", timeoutMs: TIMEOUT.POLL_DEFAULT_MS },
    );
}

/// Register a wallet's detection key with fmd-webserver. Returns the
/// subscription id for `listMatches` queries.
export async function subscribe(fmd: FmdClient, wallet: TestWallet): Promise<number> {
    const sub = await fmd.createSubscription({
        detectionKeyHex: detectionKeyToHex(wallet.detectionKey),
        gamma: wallet.detectionKey.x.length,
    });
    return sub.id;
}

export interface ActorSpec {
    nsk: bigint;
    /// If true, register the actor's detection key with fmd. Subscription
    /// id surfaces on the returned actor as `subscriptionId`.
    subscribe?: boolean;
}

export interface Actor extends TestWallet {
    nsk: bigint;
    subscriptionId?: number;
}

/// Build a named map of test actors from `{ name: spec }`. Hides the
/// `makeWallet(h.P, h.J, NSK)` + optional `subscribe` boilerplate every
/// test file repeats.
export async function setupActors<K extends string>(
    h: Harness,
    specs: Record<K, ActorSpec>,
): Promise<Record<K, Actor>> {
    const out = {} as Record<K, Actor>;
    for (const name of Object.keys(specs) as K[]) {
        const spec = specs[name];
        const w = makeWallet(h.P, h.J, spec.nsk);
        const subscriptionId = spec.subscribe ? await subscribe(h.fmd, w) : undefined;
        out[name] = { ...w, nsk: spec.nsk, subscriptionId };
    }
    return out;
}

// ──────────────────────────────────────────────────────────────────────
// Permit2 + submitIntent (deposit path — direct to MASP)
// ──────────────────────────────────────────────────────────────────────

const MASP_INTENT_ABI = [
    "function submitIntent((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function cancelIntent(uint256 id)",
    "function cancelDelay() view returns (uint32)",
    "event IntentEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, bytes32 cm0, bytes32 cm1, uint256 cvDep0X, uint256 cvDep0Y, uint256 cvDep1X, uint256 cvDep1Y, uint256 rcvTotal, uint256 clueRx0, uint256 clueRy0, uint256 ephPubX0, uint256 ephPubY0, bytes ciphertext0, uint256 clueRx1, uint256 clueRy1, uint256 ephPubX1, uint256 ephPubY1, bytes ciphertext1)",
    "event IntentFlushed(uint256 indexed id, bytes32 cm0, bytes32 cm1)",
];

export interface SubmitIntentResult {
    txHash: string;
    intentId: bigint;
}

/// Sign a Permit2 witness over `(intent, aux)` and broadcast
/// `MASP.submitIntent` directly via ethers. Bypasses the relayer; the
/// relayer still auto-flushes via `IntentEscrowed` event scrape.
export async function submitIntentDirect(args: {
    payer: ethers.NonceManager;
    intent: DepositIntent;
    aux: [AuxOutput, AuxOutput];
    tokenAddr: string;
    maxTotal: bigint;
}): Promise<SubmitIntentResult> {
    const { payer, intent, aux, tokenAddr, maxTotal } = args;
    const piHash = computePiHash(intent, aux);
    const nonce = BigInt(Date.now()) << 8n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await signPermit2Witness({
        signer: payer,
        chainId: env.chainId,
        spender: env.maspAddress,
        token: tokenAddr,
        maxTotal,
        nonce,
        deadline,
        piHash,
        permit2Address: env.permit2Address,
    });

    const masp = new ethers.Contract(env.maspAddress, MASP_INTENT_ABI, payer);
    // DEBUG: dump intent + sig before sending so we can decode any revert.
    console.log("[debug] intent=", JSON.stringify({
        chainId: intent.chainId.toString(),
        publicAssetId: intent.publicAssetId.toString(),
        publicIn: intent.publicIn.toString(),
        payer: intent.payer,
        recipient: intent.recipient,
        outCm: intent.outCm,
        cvDep0: intent.cvDep0.map((x) => x.toString()),
        cvDep1: intent.cvDep1.map((x) => x.toString()),
        rcvTotal: intent.rcvTotal.toString(),
    }));
    console.log("[debug] piHash=", piHash);
    console.log("[debug] permit2Address=", env.permit2Address, "masp=", env.maspAddress, "token=", tokenAddr);
    try {
        await masp.submitIntent.staticCall(
            [
                intent.chainId,
                intent.publicAssetId,
                intent.publicIn,
                intent.payer,
                intent.recipient,
                intent.outCm,
                intent.cvDep0,
                intent.cvDep1,
                intent.rcvTotal,
            ],
            [sig.nonce, sig.deadline, sig.maxTotal, sig.signature],
            aux.map((a) => [a.clueRx, a.clueRy, a.ephPubX, a.ephPubY, ethers.hexlify(a.ciphertext)]),
        );
    } catch (e: any) {
        console.log("[debug] staticCall revert: data=", e.data, " info=", JSON.stringify(e.info, null, 2), " err=", JSON.stringify(e?.error ?? null), " msg=", e?.shortMessage);
        // Also probe via raw eth_call to get raw revert hex.
        try {
            const iface = new ethers.Interface([
                "function submitIntent((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
            ]);
            const data = iface.encodeFunctionData("submitIntent", [
                [
                    intent.chainId,
                    intent.publicAssetId,
                    intent.publicIn,
                    intent.payer,
                    intent.recipient,
                    intent.outCm,
                    intent.cvDep0,
                    intent.cvDep1,
                    intent.rcvTotal,
                ],
                [sig.nonce, sig.deadline, sig.maxTotal, sig.signature],
                aux.map((a) => [a.clueRx, a.clueRy, a.ephPubX, a.ephPubY, ethers.hexlify(a.ciphertext)]),
            ]);
            const rpc = (payer as any).provider;
            const callRes = await rpc.send("eth_call", [{ from: await payer.getAddress(), to: env.maspAddress, data }, "latest"]);
            console.log("[debug] raw eth_call result=", callRes);
        } catch (e2: any) {
            console.log("[debug] raw eth_call err data=", e2?.data, "info=", JSON.stringify(e2?.info, null, 2));
        }
    }
    const tx = await masp.submitIntent(
        [
            intent.chainId,
            intent.publicAssetId,
            intent.publicIn,
            intent.payer,
            intent.recipient,
            intent.outCm,
            intent.cvDep0,
            intent.cvDep1,
            intent.rcvTotal,
        ],
        [sig.nonce, sig.deadline, sig.maxTotal, sig.signature],
        aux.map((a) => [
            a.clueRx,
            a.clueRy,
            a.ephPubX,
            a.ephPubY,
            ethers.hexlify(a.ciphertext),
        ]),
    );
    const receipt = await tx.wait();
    const intentId = extractIntentId(receipt, masp);
    return { txHash: tx.hash as string, intentId };
}

/// Parse every log in `receipt` whose topic[0] matches `eventName` on
/// `contract`. Foreign logs (different ABI) are silently dropped — the
/// receipt always carries logs from peripheral contracts hit during the
/// tx, and the parser would throw on them.
export function parseContractLogs(
    receipt: { logs: readonly ethers.Log[] } | null,
    contract: ethers.Contract,
    eventName: string,
): ethers.LogDescription[] {
    if (!receipt) return [];
    const out: ethers.LogDescription[] = [];
    for (const log of receipt.logs) {
        try {
            const parsed = contract.interface.parseLog({
                topics: [...log.topics],
                data: log.data,
            });
            if (parsed?.name === eventName) out.push(parsed);
        } catch {
            // log not from this ABI; skip
        }
    }
    return out;
}

function extractIntentId(
    receipt: ethers.ContractTransactionReceipt | null,
    masp: ethers.Contract,
): bigint {
    const escrowed = parseContractLogs(receipt, masp, "IntentEscrowed");
    if (escrowed.length === 0) {
        throw new Error("submitIntent: IntentEscrowed log not found");
    }
    return escrowed[0].args[0] as bigint;
}

// ──────────────────────────────────────────────────────────────────────
// High-level recipes
// ──────────────────────────────────────────────────────────────────────

export interface DepositOpts {
    h: Harness;
    wallet: TestWallet;
    nsk: Field;
    amount: bigint;
    rng: () => Field;
    auxRng: () => Field;
    asset?: bigint;
    /// ERC20 token to pay with. Defaults to `env.token2` (mDAI). Multi-
    /// asset tests pass `env.token1` (WETH) explicitly.
    tokenAddr?: string;
}

/// Deposit recipe: build intent → sign Permit2 → submit on-chain → wait
/// for relayer to flush + fmd to index → return spendable note.
export async function deposit(opts: DepositOpts): Promise<SpendableCachedNote> {
    const { h, wallet, nsk, amount, rng, auxRng, asset } = opts;
    const tokenAddr = opts.tokenAddr ?? env.token2;
    const assetId = asset ?? ASSET;
    // Permit2 maxTotal in token base units: `inAmt + fee`, mirroring
    // `MASP._computeAmounts` (publicIn-units → base-units via per-asset scale).
    const total = withFee(amount, assetId);

    const built = buildDeposit({
        ...h.bundleCommon(asset),
        publicIn: amount,
        recipient: wallet.recipient,
        output0: { rho: rng(), rcm: rng(), rcv: rng(), rcvDep: rng(), aux: rngForOutput(auxRng) },
        output1Pad: { rho: rng(), rcm: rng(), rcv: rng(), rcvDep: rng() },
    });

    await submitIntentDirect({
        payer: h.payer,
        intent: built.intent,
        aux: built.aux,
        tokenAddr,
        maxTotal: total,
    });

    const indexed = await waitForCm(h.fmd, built.cm[0]);
    return { note: built.producedNotes[0], nsk, leafIndex: indexed.leafIndex };
}

export interface TransferOpts {
    h: Harness;
    inputs: SpendableCachedNote[];
    outputs: [Note, Note];
    recipients: [TestWallet, TestWallet];
    auxRng: () => Field;
    asset?: bigint;
}

/// Build → sign → submit a transfer; wait until both output cms are
/// indexed by fmd-webserver. Returns the bundle for assertions on cm /
/// nullifiers.
export async function submitTransfer(
    opts: TransferOpts,
): Promise<Awaited<ReturnType<typeof buildTransfer>>> {
    const { h, inputs, outputs, recipients, auxRng, asset } = opts;
    if (inputs.length === 0 || inputs.length > 2) {
        throw new Error(`submitTransfer: need 1 or 2 inputs, got ${inputs.length}`);
    }
    const slot0 = await inputSlotFor(h.P, h.fmd, inputs[0]);
    const slot1 = inputs[1] ? await inputSlotFor(h.P, h.fmd, inputs[1]) : null;

    const built = await buildTransfer({
        ...h.bundleCommon(asset),
        inputs: [slot0, slot1],
        merkleRoot: await h.currentRoot(),
        outputs,
        outputRecipients: [recipients[0].recipient, recipients[1].recipient],
        outputRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
    });
    await h.relayer.submitTransact(built.payload);
    await waitForCm(h.fmd, built.cm[0]);
    await waitForCm(h.fmd, built.cm[1]);
    return built;
}

export interface WithdrawOpts {
    h: Harness;
    input: SpendableCachedNote;
    publicOut: bigint;
    change: [Note, Note];
    changeRecipient: TestWallet;
    auxRng: () => Field;
    asset?: bigint;
}

/// Build → sign → submit a withdraw; wait until both change cms are
/// indexed. Returns the bundle.
export async function submitWithdraw(
    opts: WithdrawOpts,
): Promise<Awaited<ReturnType<typeof buildWithdraw>>> {
    const { h, input, publicOut, change, changeRecipient, auxRng, asset } = opts;
    const built = await buildWithdraw({
        ...h.bundleCommon(asset),
        inputs: [await inputSlotFor(h.P, h.fmd, input), null],
        merkleRoot: await h.currentRoot(),
        publicOut,
        change,
        changeRecipients: [changeRecipient.recipient, changeRecipient.recipient],
        changeRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
    });
    await h.relayer.submitTransact(built.payload);
    await waitForCm(h.fmd, built.cm[0]);
    return built;
}

/// Same as `submitWithdraw` but routes to `MASP.withdrawNative` — MASP
/// unwraps WETH internally and forwards raw ETH to `recipientAddress`.
/// Caller must pass `asset` = the WETH asset id.
export async function submitWithdrawNative(
    opts: WithdrawOpts,
): Promise<Awaited<ReturnType<typeof buildWithdrawNative>>> {
    const { h, input, publicOut, change, changeRecipient, auxRng, asset } = opts;
    const built = await buildWithdrawNative({
        ...h.bundleCommon(asset),
        inputs: [await inputSlotFor(h.P, h.fmd, input), null],
        merkleRoot: await h.currentRoot(),
        publicOut,
        change,
        changeRecipients: [changeRecipient.recipient, changeRecipient.recipient],
        changeRandomness: [rngForOutput(auxRng), rngForOutput(auxRng)],
    });
    await h.relayer.submitTransact(built.payload);
    await waitForCm(h.fmd, built.cm[0]);
    return built;
}

// ──────────────────────────────────────────────────────────────────────
// MASP receipt log helpers
// ──────────────────────────────────────────────────────────────────────

/// Poll provider logs for an `IntentFlushed`-bearing tx that covers
/// every id in `wantedIds`. Returns the tx hash. Used by the batch-
/// flush test to detect when the relayer's flush cron has drained all N
/// pending intents into a single batch tx.
export async function waitForBatchFlushTx(args: {
    provider: ethers.JsonRpcProvider;
    masp: ethers.Contract;
    maspAddress: string;
    fromBlock: number;
    wantedIds: bigint[];
    timeoutMs?: number;
}): Promise<string> {
    const { provider, masp, maspAddress, fromBlock, wantedIds } = args;
    const flushTopic = masp.interface.getEvent("IntentFlushed")!.topicHash;
    const wanted = new Set(wantedIds.map((id) => id.toString()));
    return pollUntil(async () => {
        const logs = await provider.getLogs({
            address: maspAddress,
            topics: [flushTopic],
            fromBlock,
            toBlock: "latest",
        });
        const byTx = new Map<string, Set<string>>();
        for (const log of logs) {
            const id = BigInt(log.topics[1]).toString();
            if (!byTx.has(log.transactionHash)) byTx.set(log.transactionHash, new Set());
            byTx.get(log.transactionHash)!.add(id);
        }
        for (const [tx, ids] of byTx) {
            if ([...wanted].every((id) => ids.has(id))) return tx;
        }
        return null;
    }, { label: "batch flush tx", timeoutMs: args.timeoutMs ?? TIMEOUT.BATCH_FLUSH_MS });
}

// ──────────────────────────────────────────────────────────────────────
// FMD match decryption + verification
// ──────────────────────────────────────────────────────────────────────

/// Try to decrypt an fmd match with the wallet's ivk and recompute the
/// cm. Returns null when decryption fails (decoy hit the detection key
/// but is not for this wallet) OR when the recomputed cm does not bind
/// to the indexer's commitment (impostor note that happens to decrypt).
function tryDecryptMatch(
    P: Poseidon,
    J: Jubjub,
    w: TestWallet,
    m: FmdMatchOut,
): { payload: NotePayload; cm: Field } | null {
    const { body } = stripClueBitsPrefix(hexToBytes(m.ciphertextHex));
    const epkPacked = J.packPoint([BigInt(m.ephPubX), BigInt(m.ephPubY)]);
    const plain = decryptNote({
        J,
        ivk: w.keys.ivk,
        note: { epk: epkPacked, ciphertext: body },
    });
    if (plain === null) return null;
    const payload = decodeNotePayload(plain);
    const cm = buildNoteCommitment(P, {
        asset: payload.asset,
        value: payload.value,
        pk: w.keys.pk,
        rho: payload.rho,
        rcm: payload.rcm,
    });
    if ("0x" + m.commitmentHex.toLowerCase() !== cmToHex(cm)) return null;
    return { payload, cm };
}

/// Decrypt an fmd match with the wallet's ivk, recompute the cm from the
/// recovered payload, and assert it matches the indexer's commitment —
/// catches impostor / decoy notes that hit the detection key but weren't
/// actually addressed to this wallet.
export async function decryptAndVerifyMatch(
    P: Poseidon,
    J: Jubjub,
    w: TestWallet,
    m: FmdMatchOut,
): Promise<{ payload: NotePayload; cm: Field }> {
    const r = tryDecryptMatch(P, J, w, m);
    if (r === null) throw new Error("decryptAndVerifyMatch: decoy or cm mismatch");
    return r;
}

/// Filter `listMatches` output down to genuine recipient notes. FMD γ=5
/// gives a 1/32 false-positive rate per non-recipient ciphertext: every test
/// run that produces enough notes will occasionally see decoys hit the
/// detection key. Counting raw matches is therefore flaky. Decryption with
/// the recipient's `ivk` returns null on FPs — we drop those, plus any whose
/// recomputed `cm` does not bind to the indexer commitment.
export function filterRealMatches(
    P: Poseidon,
    J: Jubjub,
    w: TestWallet,
    matches: FmdMatchOut[],
): FmdMatchOut[] {
    return matches.filter((m) => tryDecryptMatch(P, J, w, m) !== null);
}

// ──────────────────────────────────────────────────────────────────────
// Re-exports for one-stop test imports
// ──────────────────────────────────────────────────────────────────────

export {
    buildNoteCommitment,
    buildNullifierFromNsk,
    type Note,
    type SpendableCachedNote,
} from "@lelantos-org/sdk";
export {
    type Erc20Helpers,
    inputSlotFor,
    makeWallet,
    noteFor,
    rngForOutput,
    setupErc20,
    setupWeth,
    snapshotBalances,
    type TestWallet,
    waitForCm,
    waitForAdvance,
} from "./scenario";
export { ASSET, FEE_BPS, baseAmt, feeFor, scaleFor, withFee, MASP_ABI, TIMEOUT } from "./constants";
export { cmToHex, counter, nfToHex, pollUntil } from "./utils";
