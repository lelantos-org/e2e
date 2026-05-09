// Test harness: one-call setup for the boilerplate every e2e file shared
// (Poseidon/Jubjub build, ethers wiring, RelayerClient, FmdClient, actor
// derivation, ERC20/WETH funding) plus the higher-level submit recipes
// that wrap the buildTransfer/buildWithdraw + relayer + waitForCm cycle.
//
// Tests pull their state from `Harness` instead of redeclaring it in
// every `beforeAll`.

import { resolve } from "node:path";

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
import { ASSET, MASP_ABI, TREE_DEPTH, withFee } from "./constants";
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
    wasmPath: resolve(env.circuitsBuild, "2x2_js", "2x2.wasm"),
    zkeyPath: resolve(env.circuitsBuild, "2x2_final.zkey"),
};

/// Shared aux randomness seed. Each test calls `newAuxRng()` to get its
/// own independent stream so parallel files don't entangle.
export const AUX_RNG_SEED = 0xfacecafen;
export const newAuxRng = () => counter(AUX_RNG_SEED);

// ──────────────────────────────────────────────────────────────────────
// Harness
// ──────────────────────────────────────────────────────────────────────

export interface Harness {
    P: Poseidon;
    J: Jubjub;
    provider: ethers.JsonRpcProvider;
    payer: ethers.Wallet;
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
    const payer = new ethers.Wallet(env.payerKey, provider);
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

export async function waitForFmdHealth(): Promise<void> {
    await pollUntil(
        async () => {
            const r = await fetch(env.fmdUrl + "/health").catch(() => null);
            return r?.ok ? true : null;
        },
        { label: "fmd health", timeoutMs: 60_000 },
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

// ──────────────────────────────────────────────────────────────────────
// Permit2 + submitIntent (deposit path — direct to MASP)
// ──────────────────────────────────────────────────────────────────────

const MASP_INTENT_ABI = [
    "function submitIntent((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
    "function cancelIntent(uint256 id)",
    "function cancelDelay() view returns (uint32)",
    "event IntentEscrowed(uint256 indexed id, address indexed payer, address indexed recipient, uint64 publicAssetId, uint64 publicIn, bytes32 cm0, bytes32 cm1, uint256 clueRx0, uint256 clueRy0, uint256 ephPubX0, uint256 ephPubY0, bytes ciphertext0, uint256 clueRx1, uint256 clueRy1, uint256 ephPubX1, uint256 ephPubY1, bytes ciphertext1)",
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
    payer: ethers.Wallet;
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
    const tx = await masp.submitIntent(
        [
            intent.chainId,
            intent.publicAssetId,
            intent.publicIn,
            intent.payer,
            intent.recipient,
            intent.outCm,
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

function extractIntentId(
    receipt: ethers.ContractTransactionReceipt | null,
    masp: ethers.Contract,
): bigint {
    if (!receipt) throw new Error("submitIntent: no receipt");
    for (const log of receipt.logs) {
        try {
            const parsed = masp.interface.parseLog({
                topics: [...log.topics],
                data: log.data,
            });
            if (parsed?.name === "IntentEscrowed") return parsed.args[0] as bigint;
        } catch {
            // log not from MASP; skip
        }
    }
    throw new Error("submitIntent: IntentEscrowed log not found");
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
        output0: { rho: rng(), rcm: rng(), rcv: rng(), aux: rngForOutput(auxRng) },
        output1Pad: { rho: rng(), rcm: rng(), rcv: rng() },
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
// FMD match decryption + verification
// ──────────────────────────────────────────────────────────────────────

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
    return matches.filter((m) => {
        const { body } = stripClueBitsPrefix(hexToBytes(m.ciphertextHex));
        const epkPacked = J.packPoint([BigInt(m.ephPubX), BigInt(m.ephPubY)]);
        const plain = decryptNote({
            J,
            ivk: w.keys.ivk,
            note: { epk: epkPacked, ciphertext: body },
        });
        if (plain === null) return false;
        const payload = decodeNotePayload(plain);
        const cm = buildNoteCommitment(P, {
            asset: payload.asset,
            value: payload.value,
            pk: w.keys.pk,
            rho: payload.rho,
            rcm: payload.rcm,
        });
        return "0x" + m.commitmentHex.toLowerCase() === cmToHex(cm);
    });
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
    type TestWallet,
    waitForCm,
    waitForAdvance,
} from "./scenario";
export { ASSET, FEE_BPS, baseAmt, feeFor, scaleFor, withFee, MASP_ABI } from "./constants";
export { cmToHex, counter, nfToHex, pollUntil } from "./utils";
