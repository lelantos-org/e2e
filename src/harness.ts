import { createRequire } from "node:module";

import { ethers } from "ethers";

import { Jubjub, Poseidon } from "@lelantos-org/sdk/crypto";
import { FmdClient } from "@lelantos-org/sdk/fmd-server";
import { signPermit2Witness } from "@lelantos-org/sdk/permit2";
import { type AuxOutput, computePiHash, type DepositRequest } from "@lelantos-org/sdk/protocol";
import { RelayerClient } from "@lelantos-org/sdk/relayer";

import { RELAYER } from "./accounts.js";
import { ASSET, MASP_ABI, MASP_DEPOSIT_ABI, TIMEOUT, TREE_DEPTH } from "./constants.js";
import { env } from "./env.js";
import { type Erc20Helpers, ExplorerClient, setupErc20, setupWeth } from "./scenario.js";
import { payerEthSigner } from "./signers.js";
import { counter, pollUntil } from "./utils.js";

const resolve = createRequire(import.meta.url).resolve;
export const PROVER_PATHS = {
    wasmPath: resolve("@lelantos-org/circuits/3x3/3x3.wasm"),
    zkeyPath: resolve("@lelantos-org/circuits/3x3/3x3_final.zkey"),
};

// Test files should pass a file-unique seed; cross-file collisions produce
// identical FMD clues + ECDH ephemerals on the shared anvil.
export const AUX_RNG_SEED = 0xfacecafen;
export const newAuxRng = (seed: bigint = AUX_RNG_SEED) => counter(seed);

export interface Harness {
    P: Poseidon;
    J: Jubjub;
    provider: ethers.JsonRpcProvider;
    payer: ethers.Wallet;
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

// Mirrors the asset registry fixture the stack deploys. `weth` is the only
// wrapped-native entry; the rest are plain mocks with a public `mint`.
export function tokenAddressFor(asset: bigint): { address: string; kind: "erc20" | "weth" } {
    switch (asset) {
        case 1n: return { address: env.token1, kind: "weth" };
        case 2n: return { address: env.token2, kind: "erc20" };
        case 3n: return { address: env.token3, kind: "erc20" };
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
    // Plain ethers.Wallet — fetches `pending` nonce from anvil on every send.
    // We can't use NonceManager here because the SDK's viem PrivateKeySigner
    // independently sends txs from the same account; cached NonceManager
    // diverges from chain state and trips "nonce too low".
    const payer = new ethers.Wallet(env.payerKey, provider);
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

export interface SubmitDepositResult {
    txHash: string;
    depositId: bigint;
}

// Bypasses SDK Wallet: used by negative tests that need malformed inputs and
// by batch-flush which fires N submits without waiting for cm indexation.
/// Fresh Permit2 nonce, unique per call.
///
/// Permit2 nonces are an unordered bitmap: any unused value works, but a
/// repeat reverts `InvalidNonce()`. Deriving one from `Date.now()` alone
/// collides whenever two deposits are signed inside the same millisecond —
/// which is exactly what `batch-flush` does when it fires N submits through
/// `Promise.all`, so it failed only sometimes. The counter makes it
/// deterministic; the timestamp seed keeps separate runs against the same
/// anvil from reusing each other's slots.
let permit2Nonce = BigInt(Date.now()) << 8n;
function nextPermit2Nonce(): bigint {
    return permit2Nonce++;
}

export async function submitDepositDirect(args: {
    payer: ethers.Signer;
    deposit: DepositRequest;
    aux: AuxOutput;
    tokenAddr: string;
    maxTotal: bigint;
    deadline?: bigint;
}): Promise<SubmitDepositResult> {
    const { payer, deposit, aux, tokenAddr, maxTotal } = args;
    const piHash = computePiHash(deposit, aux);
    const nonce = nextPermit2Nonce();
    const deadline = args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
    // `signPermit2Witness` takes a viem-shaped `EthSigner`. Use the shared
    // PAYER signer (memoised); tx broadcast still goes through the ethers
    // `payer` below.
    const sig = await signPermit2Witness({
        signer: payerEthSigner(),
        chainId: env.chainId,
        spender: env.maspAddress,
        token: tokenAddr,
        maxTotal,
        nonce,
        deadline,
        piHash,
        permit2Address: env.permit2Address,
    });
    const masp = new ethers.Contract(env.maspAddress, MASP_DEPOSIT_ABI, payer);
    const tx = await masp.deposit(
        [
            deposit.chainId,
            deposit.publicAssetId,
            deposit.publicIn,
            deposit.payer,
            deposit.recipient,
            deposit.outCm,
            deposit.cvDep,
            deposit.rcv,
        ],
        [sig.nonce, sig.deadline, sig.maxTotal, sig.signature],
        [aux.clueRx, aux.clueRy, aux.ephPubX, aux.ephPubY, ethers.hexlify(aux.ciphertext)],
    );
    const receipt = await tx.wait();
    const depositId = extractDepositId(receipt, masp);
    return { txHash: tx.hash, depositId };
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

function extractDepositId(
    receipt: ethers.TransactionReceipt | ethers.ContractTransactionReceipt | null,
    masp: ethers.Contract,
): bigint {
    const escrowed = parseContractLogs(receipt, masp, "DepositEscrowed");
    if (escrowed.length === 0) {
        throw new Error("deposit: DepositEscrowed log not found");
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
    const flushTopic = masp.interface.getEvent("DepositFlushed")!.topicHash;
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
// 0.11 split the root export into per-area subpaths; these are grouped by the
// subpath each symbol now lives in.
export { assetId, circuitAmount, TRANSACT_3X3 } from "@lelantos-org/sdk";
export { buildDeposit } from "@lelantos-org/sdk/bundle";
export { buildNoteCommitment, type Field } from "@lelantos-org/sdk/crypto";
export type { Note } from "@lelantos-org/sdk/notes";
export type { SpendableCachedNote } from "@lelantos-org/sdk/circuit";
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

// Local re-exports. Tests should be able to get everything they need from
// this module plus `./fixture.js`, so anything a test reaches for belongs here.
export {
    amt, ASSET, ASSETS, baseAmt, circuitFee, DEAD_ADDRESS, FEE_BPS, feeFor, LIST_LIMIT,
    MASP_ABI, MASP_DEPOSIT_ABI, MOCK_ERC20_ABI, N_IN, N_OUT, POLL, type PollOpts, REVERT,
    scaleFor, SWAP_WRAPPER_ABI, SYNC_LIMIT, TEST_TIMEOUT, TIMEOUT, withFee,
} from "./constants.js";
export {
    accruedFee, type Erc20Helpers, ExplorerClient, expectBalanceDeltas,
    makeWallet, noteFor, padOutputs, recipientCommitments, rngForOutput, setupErc20, setupWeth,
    snapshotBalances, type CircuitWallet, trackedAddrs, waitForAdvance, waitForCm,
} from "./scenario.js";
// NB: `fixture.ts` is deliberately *not* re-exported here — it imports this
// module, and routing it back through the barrel would make the cycle load-
// order sensitive. Tests import it directly from `../src/fixture.js`.
export { payerEthSigner } from "./signers.js";
export { cmToHex, counter, errorText, expectRevert, nfToHex, pollUntil } from "./utils.js";
export { awaitBalance, awaitOwn, awaitRecipient } from "./wait.js";
export { createTestWallet, TEST_NSK } from "./wallet.js";
