// The barrel every test file imports from: the shared stack handle, the direct
// (non-SDK) deposit path, and re-exports of everything under `src/`.

import { ethers } from "ethers";

import { Jubjub, Poseidon } from "@lelantos-org/sdk/primitives";
import {
    buildDeposit,
    computePiHash,
    type OutputRecipient,
    signPermit2Witness,
} from "@lelantos-org/sdk/protocol";
import { FmdClient, RelayerClient } from "@lelantos-org/sdk/services";

import { MASP_ABI, MASP_DEPOSIT_ABI } from "./protocol/abi.js";
import { depositTotal, FEE_HEADROOM } from "./protocol/amounts.js";
import { ASSET, plainAssetOf, scaleFor } from "./protocol/assets.js";
import { type BundleItem, bundleItems, parseContractLogs } from "./protocol/logs.js";
import { TREE_DEPTH } from "./protocol/shape.js";
import { PROVER_PATHS } from "./testkit/prover.js";
import { type DepositFeeArg, type FeeRng, noteRandomness } from "./testkit/deposit-fee.js";
import { TIMEOUT } from "./testkit/timeouts.js";
import { env } from "./env.js";
import { type Erc20Helpers, setupErc20, setupWeth } from "./scenario.js";
import { payerEthSigner } from "./signers.js";
import { mineIfAnvil, rpcProvider, SerialWallet, settleNonce } from "./tx.js";
import { counter, pollUntil } from "./utils.js";

/**
 * The randomness source for a note's FMD clue and ECDH ephemeral.
 *
 * No default seed: two files drawing from one would publish identical clues
 * and ephemerals on the shared anvil. Keep it far from the file's note-rng
 * seed too, since `counter` seeds a few apart share most of their draws.
 */
export const newAuxRng = (seed: bigint) => counter(seed);

export interface Harness {
    P: Poseidon;
    J: Jubjub;
    provider: ethers.JsonRpcProvider;
    payer: ethers.Wallet;
    masp: ethers.Contract;
    relayer: RelayerClient;
    fmd: FmdClient;
    bundleCommon(asset?: bigint): {
        P: Poseidon;
        J: Jubjub;
        chainId: bigint;
        asset: bigint;
        payerAddress: string;
        relayerAddress: string;
        recipientAddress: string;
        artifacts: typeof PROVER_PATHS;
        treeDepth: number;
    };
}

let _P: Promise<Poseidon> | undefined;
let _J: Promise<Jubjub> | undefined;

// Mirrors the asset registry fixture the stack deploys. WETH is the only
// wrapped-native entry; the rest are mocks with a public `mint`.
export function tokenAddressFor(asset: bigint): { address: string; kind: "erc20" | "weth" } {
    // Through the plain id: a yield asset is registered alongside the plain one
    // and shares its ERC-20, so it funds and settles out of the same token
    // rather than needing a row of its own here.
    switch (plainAssetOf(asset)) {
        case 1n: return { address: env.token1, kind: "weth" };
        case 2n: return { address: env.token2, kind: "erc20" };
        case 3n: return { address: env.token3, kind: "erc20" };
        default: throw new Error(`tokenAddressFor: unknown asset id ${asset}`);
    }
}

/**
 * Mint (or wrap) `baseUnits` of `asset` for the payer, plus slack for fees.
 *
 * Every deposit pulls a third amount on top of principal and the pool's
 * protocol fee: the note paying whoever flushes it. Callers size `baseUnits`
 * with `withFee`, which covers only the first two, so funding exactly `withFee`
 * leaves the Permit2 pull short and reverts inside the token with
 * `TRANSFER_FROM_FAILED`, naming neither the fee nor the deposit.
 *
 * The slack is added here rather than at each call site because this is the one
 * place that decides what the payer needs, and because the charge moves with
 * gas.
 */
export async function fundPayerForAsset(
    h: Harness,
    asset: bigint,
    baseUnits: bigint,
): Promise<Erc20Helpers> {
    const { address, kind } = tokenAddressFor(asset);
    const funded = baseUnits + FEE_HEADROOM * scaleFor(asset);
    return kind === "weth"
        ? setupWeth(h.payer, address, env.permit2Address, funded)
        : setupErc20(h.payer, address, env.permit2Address, funded);
}

export async function setupHarness(): Promise<Harness> {
    const P = await (_P ??= Poseidon.build());
    const J = await (_J ??= Jubjub.build());
    const provider = rpcProvider(env.rpcUrl);
    // Vitest reuses one anvil, so flush first: file N's nonce query must not
    // read stale state.
    await mineIfAnvil(provider, 2);
    // `SerialWallet` re-reads the `pending` nonce from anvil on every send. It
    // keeps no local cache, because the SDK's viem `PrivateKeySigner` sends
    // from the same account and a local counter would diverge from chain state
    // and trip "nonce too low". Over a plain `Wallet` it adds a process-wide
    // send queue and a retry for the case where an SDK send wins the race
    // anyway; see `tx.ts`.
    const payer = new SerialWallet(env.payerKey, provider);
    // Wait for the previous file's transactions to leave the pool.
    await settleNonce(provider, payer.address);
    const masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
    const relayer = new RelayerClient(env.relayerUrl);
    const fmd = new FmdClient(env.fmdUrl, env.chainId);

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
            relayerAddress: env.bundlerAddress,
            recipientAddress: env.recipientAddress,
            artifacts: PROVER_PATHS,
            treeDepth: TREE_DEPTH,
        }),
    };
}

async function waitForFmdHealth(): Promise<void> {
    await pollUntil(
        async (signal) => {
            const r = await fetch(env.fmdUrl + "/health", {
                signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT.HTTP_MS)]),
            });
            if (!r.ok) throw new Error(`GET /health: ${r.status}`);
            return true;
        },
        { label: "fmd health", timeoutMs: TIMEOUT.POLL_DEFAULT_MS },
    );
}

interface SubmitDepositResult {
    txHash: string;
    depositId: bigint;
}

/** A deposit built by `buildDeposit` and not yet submitted. */
export type BuiltDeposit = ReturnType<typeof buildDeposit>;

/**
 * Fresh Permit2 nonce, unique per call.
 *
 * Permit2 nonces are an unordered bitmap: any unused value works, but a repeat
 * reverts `InvalidNonce()`. Deriving one from `Date.now()` alone collides
 * whenever two deposits are signed inside the same millisecond, which is what
 * `batch-flush` does when it fires N submits through `Promise.all`. The counter
 * makes it deterministic; the timestamp seed keeps separate runs against the
 * same anvil from reusing each other's slots.
 */
let permit2Nonce = BigInt(Date.now()) << 8n;
function nextPermit2Nonce(): bigint {
    return permit2Nonce++;
}

/**
 * Build a deposit for the direct path, bypassing the SDK wallet.
 *
 * The depositor's note draws its randomness from the same counters as the fee
 * note, in the order `buildDeposit` consumes them, so reruns reproduce. Build
 * every deposit of a burst first and submit afterwards: the draws must stay
 * sequential even when the submits do not.
 */
export function buildDirectDeposit(
    h: Harness,
    args: {
        /** Circuit units. */
        amount: bigint;
        asset?: bigint;
        recipient: OutputRecipient;
        rngs: FeeRng;
        /** From `relayerFeeNote` (flushes) or `unflushableFee` (stays escrowed). */
        fee: (rngs: FeeRng) => DepositFeeArg;
    },
): BuiltDeposit {
    return buildDeposit({
        ...h.bundleCommon(args.asset ?? ASSET),
        publicIn: args.amount,
        recipient: args.recipient,
        output0: noteRandomness(args.rngs),
        fee: args.fee(args.rngs),
    });
}

/**
 * Submit a deposit built by `buildDirectDeposit`, bypassing the SDK wallet.
 *
 * Used by negative tests that need malformed inputs, and by files that fire
 * several submits without waiting for commitment indexation.
 *
 * The token and `maxTotal` follow from the deposit itself: its asset's token,
 * and principal plus protocol fee plus a same-asset fee note. Override
 * `maxTotal` only to sign a ceiling the deposit does not fit.
 */
export async function submitDepositDirect(
    h: Harness,
    built: BuiltDeposit,
    opts: {
        /** Sender; defaults to `h.payer`. A `NonceManager` for parallel sends. */
        payer?: ethers.Signer;
        maxTotal?: bigint;
        deadline?: bigint;
    } = {},
): Promise<SubmitDepositResult> {
    const { deposit, aux, feeAux } = built;
    const asset = deposit.publicAssetId;
    // A fee note in another asset is pulled as a second token under its own
    // ceiling; a same-asset note rides in `maxTotal` and signs `maxFee = 0`.
    const feeElsewhere = deposit.feeIn !== 0n && deposit.feeAssetId !== asset;
    const maxTotal = opts.maxTotal ??
        depositTotal(deposit.publicIn, feeElsewhere ? 0n : deposit.feeIn, asset);
    // Both leaves are inside the Permit2 witness, so a relayer cannot swap the
    // fee note and reuse the payer's signature.
    const piHash = computePiHash(deposit, aux, feeAux);
    const deadline = opts.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
    // `signPermit2Witness` takes a viem-shaped `EthSigner`, so the memoised
    // PAYER signer is used here. Broadcast still goes through the ethers
    // `payer` below.
    const sig = await signPermit2Witness({
        signer: payerEthSigner(),
        chainId: env.chainId,
        spender: env.maspAddress,
        token: tokenAddressFor(asset).address,
        maxTotal,
        ...(feeElsewhere
            ? {
                  feeToken: tokenAddressFor(deposit.feeAssetId).address,
                  maxFee: deposit.feeIn * scaleFor(deposit.feeAssetId),
              }
            : {}),
        nonce: nextPermit2Nonce(),
        deadline,
        piHash,
        permit2Address: env.permit2Address,
    });
    const masp = new ethers.Contract(env.maspAddress, MASP_DEPOSIT_ABI, opts.payer ?? h.payer);
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
            deposit.feeAssetId,
            deposit.feeIn,
            deposit.feeCm,
            deposit.feeCvDep,
            deposit.feeRcv,
        ],
        [sig.nonce, sig.deadline, sig.maxTotal, sig.maxFee, sig.signature],
        [aux.clueRx, aux.clueRy, aux.ephPubX, aux.ephPubY, ethers.hexlify(aux.ciphertext)],
        [
            feeAux.clueRx,
            feeAux.clueRy,
            feeAux.ephPubX,
            feeAux.ephPubY,
            ethers.hexlify(feeAux.ciphertext),
        ],
    );
    const receipt = await tx.wait();
    const escrowed = parseContractLogs(receipt, masp, "DepositEscrowed");
    if (escrowed.length !== 1) {
        throw new Error(`deposit ${tx.hash}: expected one DepositEscrowed log, got ${escrowed.length}`);
    }
    return { txHash: tx.hash, depositId: escrowed[0].args[0] as bigint };
}

/**
 * The operations `txHash` landed, split by `bundleItems` against this stack's
 * pool and adapters.
 */
export async function txBundleItems(
    provider: ethers.JsonRpcProvider,
    txHash: string,
): Promise<{ receipt: ethers.TransactionReceipt; items: BundleItem[] }> {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error(`no receipt for ${txHash}`);
    const items = bundleItems(receipt, {
        masp: env.maspAddress,
        nativeAdapter: env.nativeAdapterAddress,
        swapWrapper: env.swapWrapperAddress,
    });
    return { receipt, items };
}

/**
 * The item a spend landed as: the one whose output commitments are `r`'s.
 *
 * Found by commitment rather than position, because a spend shares its
 * transaction with whatever else the relayer bundled.
 */
export async function spendItem(
    provider: ethers.JsonRpcProvider,
    r: { txHash: string; commitments: readonly string[] },
): Promise<BundleItem> {
    const { items } = await txBundleItems(provider, r.txHash);
    const want = r.commitments.map((c) => c.toLowerCase());
    const item = items.find((i) => i.cms.length === want.length && i.cms.every((c, k) => c === want[k]));
    if (!item) {
        throw new Error(
            `${r.txHash}: no operation emitted commitments ${want.join(", ")}; ` +
                `items: ${items.map((i) => `${i.kind}[${i.cms.length}]`).join(" ")}`,
        );
    }
    return item;
}

/**
 * Wait for one flush operation that carries every id in `wantedIds`.
 *
 * One operation, not one transaction: a flush shares its transaction with any
 * other operation bundled alongside it, and two flushes can share one too, so
 * ids that straddle two flushes in the same transaction do not count as one
 * batch.
 */
export async function waitForBatchFlushTx(
    h: Harness,
    args: { fromBlock: number; wantedIds: readonly bigint[]; timeoutMs?: number },
): Promise<{ txHash: string; item: BundleItem }> {
    const { provider, masp } = h;
    const { fromBlock, wantedIds } = args;
    const flushTopic = masp.interface.getEvent("DepositFlushed")!.topicHash;
    const wanted = wantedIds.map((id) => id.toString());
    return pollUntil(async () => {
        const logs = await provider.getLogs({
            address: env.maspAddress,
            topics: [flushTopic],
            fromBlock,
            toBlock: "latest",
        });
        const txs = new Set(
            logs.filter((l) => wanted.includes(BigInt(l.topics[1]).toString())).map((l) => l.transactionHash),
        );
        for (const txHash of txs) {
            const { items } = await txBundleItems(provider, txHash);
            const item = items.find((i) => {
                const ids = new Set(i.depositIds.map((id) => id.toString()));
                return i.kind === "flush" && wanted.every((id) => ids.has(id));
            });
            if (item) return { txHash, item };
        }
        return null;
    }, { label: "batch flush tx", timeoutMs: args.timeoutMs ?? TIMEOUT.BATCH_FLUSH_MS });
}

// SDK re-exports, so tests import everything from `./harness`.
export { isWalletError } from "@lelantos-org/sdk";

// Local re-exports. A test should need nothing beyond this module and
// `./fixture.js`.
export {
    BUNDLER_ABI, BUNDLER_FACTORY_ABI, MASP_ABI, MASP_TRANSFER_ABI, MOCK_ERC20_ABI, SWAP_WRAPPER_ABI,
} from "./protocol/abi.js";
export {
    type BundleItem, type BundleItemKind, bundleItems, bundleOutcome, parseContractLogs,
} from "./protocol/logs.js";
export { type QueuedOp, RelayerHooks } from "./relayer-hooks.js";
export {
    amt,
    baseAmt,
    circuitFee,
    depositTotal,
    FEE_BPS,
    FEE_HEADROOM,
    feeFor,
    netOfGross,
    withFee,
} from "./protocol/amounts.js";
export { ASSET, ASSETS, scaleFor, YIELD_ASSETS } from "./protocol/assets.js";
export { errorText, REVERT } from "./protocol/reverts.js";
export { LEAVES_PER_DEPOSIT, N_IN, N_OUT } from "./protocol/shape.js";
export { DEAD_ADDRESS } from "./chain/well-known.js";
export { SYNC_LIMIT, TEST_TIMEOUT } from "./testkit/timeouts.js";
export {
    accruedFee, type CircuitWallet, type Erc20Helpers, expectBalanceDeltas, expectLeafInItem,
    findIndexedNote, makeWallet, snapshotBalances, trackedAddrs, waitForCm,
} from "./scenario.js";
export { expectRevert } from "./testkit/expect-revert.js";
export {
    asSubmit, type CapturedRequest, captureSubmits, relayerSignerState, replay, type SignerState,
    type SubmitBody, submitBody, type SubmitCapture, tampered,
} from "./testkit/raw-relayer.js";
export {
    expectPoolSettled, type Observed, observeYield,
} from "./testkit/yield-ledger.js";
export {
    cancelDepositAfterDelay, EscrowJanitor, escrowOf, isEscrowed,
} from "./testkit/cancel-deposit.js";
export { quoteDepositFee, relayerFeeNote, unflushableFee } from "./testkit/deposit-fee.js";
export {
    expectRelayerPaid,
    expectRelayerPaidOnCommitment,
    expectRelayerPaidOnDeposit,
    relayerFeeWallet,
} from "./testkit/relayer-fee.js";
export { cmToHex, counter } from "./utils.js";
export { mineIfAnvil, settleNonce } from "./tx.js";
export { awaitBalance, awaitOwn, awaitRecipient, shieldedBalance, syncedBalance } from "./wait.js";
export { createTestWallet, TEST_NSK } from "./wallet.js";
// `fixture.ts` is not re-exported here: it imports this module, and routing it
// back through the barrel would make the cycle load-order sensitive. Tests
// import it directly from `../src/fixture.js`.
