import { createRequire } from "node:module";

import { ethers } from "ethers";

import {
    type AuxOutput,
    computePiHash,
    type DepositIntent,
    FmdClient,
    Jubjub,
    Poseidon,
    RelayerClient,
    signPermit2Witness,
} from "@lelantos-org/sdk";

import { RELAYER } from "./accounts.js";
import { ASSET, MASP_ABI, MASP_INTENT_ABI, TIMEOUT, TREE_DEPTH } from "./constants.js";
import { env } from "./env.js";
import { type Erc20Helpers, ExplorerClient, setupErc20, setupWeth } from "./scenario.js";
import { counter, pollUntil } from "./utils.js";

const resolve = createRequire(import.meta.url).resolve;
export const PROVER_PATHS = {
    wasmPath: resolve("@lelantos-org/circuits/2x2/2x2.wasm"),
    zkeyPath: resolve("@lelantos-org/circuits/2x2/2x2_final.zkey"),
};

// Test files should pass a file-unique seed; cross-file collisions produce
// identical FMD clues + ECDH ephemerals on the shared anvil.
export const AUX_RNG_SEED = 0xfacecafen;
export const newAuxRng = (seed: bigint = AUX_RNG_SEED) => counter(seed);

export interface Harness {
    P: Poseidon;
    J: Jubjub;
    provider: ethers.JsonRpcProvider;
    payer: ethers.NonceManager;
    masp: ethers.Contract;
    relayer: RelayerClient;
    fmd: FmdClient;
    explorer: ExplorerClient;
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
    currentRoot(): Promise<bigint>;
}

export interface SetupOpts {
    fund?: { kind: "erc20" | "weth"; token: string; amount: bigint }[];
}

let _P: Promise<Poseidon> | undefined;
let _J: Promise<Jubjub> | undefined;

export function tokenAddressFor(asset: bigint): { address: string; kind: "erc20" | "weth" } {
    switch (asset) {
        case 1n: return { address: env.token1, kind: "weth" };
        case 2n: return { address: env.token2, kind: "erc20" };
        default: throw new Error(`tokenAddressFor: unknown asset id ${asset}`);
    }
}

export async function fundPayerForAsset(
    h: Harness,
    asset: bigint,
    baseUnits: bigint,
): Promise<Erc20Helpers> {
    const { address, kind } = tokenAddressFor(asset);
    return kind === "weth"
        ? setupWeth(h.payer, address, env.permit2Address, baseUnits)
        : setupErc20(h.payer, address, env.permit2Address, baseUnits);
}

export async function setupHarness(opts: SetupOpts = {}): Promise<Harness> {
    const P = await (_P ??= Poseidon.build());
    const J = await (_J ??= Jubjub.build());
    const provider = new ethers.JsonRpcProvider(env.rpcUrl);
    // Vitest reuses one anvil; flush so file N's nonce query is not stale.
    await flushMempool(provider);
    // NonceManager: back-to-back sends (mint→approve) must not race anvil's
    // `pending` counter. SDK Wallet shares this instance via createTestWallet.
    const payer = new ethers.NonceManager(new ethers.Wallet(env.payerKey, provider));
    const masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
    const relayer = new RelayerClient(env.relayerUrl);
    const fmd = new FmdClient(env.fmdUrl, env.chainId);
    const explorer = new ExplorerClient(env.explorerUrl, env.chainId);

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
        explorer,
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

async function flushMempool(provider: ethers.JsonRpcProvider): Promise<void> {
    try {
        await provider.send("anvil_mine", ["0x2"]);
    } catch {
        // not anvil
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

export interface SubmitIntentResult {
    txHash: string;
    intentId: bigint;
}

// Bypasses SDK Wallet: used by negative tests that need malformed inputs and
// by batch-flush which fires N submits without waiting for cm indexation.
export async function submitIntentDirect(args: {
    payer: ethers.NonceManager;
    intent: DepositIntent;
    aux: [AuxOutput, AuxOutput];
    tokenAddr: string;
    maxTotal: bigint;
    deadline?: bigint;
}): Promise<SubmitIntentResult> {
    const { payer, intent, aux, tokenAddr, maxTotal } = args;
    const piHash = computePiHash(intent, aux);
    const nonce = BigInt(Date.now()) << 8n;
    const deadline = args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
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
            intent.cvDep0,
            intent.cvDep1,
            intent.rcvTotal,
        ],
        [sig.nonce, sig.deadline, sig.maxTotal, sig.signature],
        aux.map((a) => [a.clueRx, a.clueRy, a.ephPubX, a.ephPubY, ethers.hexlify(a.ciphertext)]),
    );
    const receipt = await tx.wait();
    const intentId = extractIntentId(receipt, masp);
    return { txHash: tx.hash, intentId };
}

// Skips logs from foreign ABIs (ethers parseLog throws on those).
export function parseContractLogs(
    receipt: ethers.TransactionReceipt | ethers.ContractTransactionReceipt | null,
    contract: ethers.Contract,
    eventName: string,
): ethers.LogDescription[] {
    if (!receipt) return [];
    const out: ethers.LogDescription[] = [];
    for (const log of receipt.logs) {
        try {
            const parsed = contract.interface.parseLog(log);
            if (parsed?.name === eventName) out.push(parsed);
        } catch {
            // wrong contract
        }
    }
    return out;
}

function extractIntentId(
    receipt: ethers.TransactionReceipt | ethers.ContractTransactionReceipt | null,
    masp: ethers.Contract,
): bigint {
    const escrowed = parseContractLogs(receipt, masp, "IntentEscrowed");
    if (escrowed.length === 0) {
        throw new Error("submitIntent: IntentEscrowed log not found");
    }
    return escrowed[0].args[0] as bigint;
}

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

// SDK re-exports — kept here so tests import everything from `./harness`.
export {
    buildNoteCommitment,
    type Note,
    type SpendableCachedNote,
} from "@lelantos-org/sdk";
export {
    DepositAdapterError,
    InsufficientCoverError,
    NetworkError,
    NetworkNotDeployedError,
    PermitRejectedError,
    ProverError,
    SelectionError,
    TxMiningError,
    WalletConfigError,
    WalletError,
    type WalletErrorCode,
} from "@lelantos-org/sdk/errors";

// Local re-exports.
export {
    ASSET, ASSETS, baseAmt, DEAD_ADDRESS, FEE_BPS, feeFor, MASP_ABI, POLL,
    scaleFor, TIMEOUT, withFee,
} from "./constants.js";
export {
    type Erc20Helpers, ExplorerClient, expectBalanceDeltas, inputSlotFor,
    makeWallet, noteFor, rngForOutput, setupErc20, setupWeth, snapshotBalances,
    type TestWallet, waitForAdvance, waitForCm,
} from "./scenario.js";
export { cmToHex, counter, expectRevert, nfToHex, pollUntil } from "./utils.js";
export { createTestWallet, TEST_NSK } from "./wallet.js";
