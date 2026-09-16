// The payer's way out of a deposit no relayer will flush.
//
// `cancelDeposit` takes the digest preimage the pool dropped from storage at
// submit, so every argument is recovered from the deposit's own
// `DepositEscrowed` log plus the block it landed in. Passing a value the
// deposit did not carry reverts `DigestMismatch`, which is the point: the
// refund goes to the digest-bound payer, not to whoever calls.
//
// Tests use this for cleanup as much as for coverage. The relayer's flush picks
// the oldest pending deposits and stops at the batch size, so a deposit it
// declines to flush sits at the head of that window and is re-picked every
// tick. The suite shares one stack, so leaving one behind would stall the
// deposits of every test file that runs afterwards: `EscrowJanitor` exists so a
// failing test cannot do that.

import { ethers } from "ethers";

import {
    type AssetId,
    assetId,
    type DepositEscrow,
    evmAddress,
    hex32,
} from "@lelantos-org/sdk";

import { MASP_ABI, MASP_DEPOSIT_ABI } from "../protocol/abi.js";
import { parseContractLogs } from "../protocol/logs.js";
import { env } from "../env.js";
import { log } from "../utils.js";

/** What a cancel needs from the stack: a reader, and the payer that signs. */
export interface CancelCtx {
    provider: ethers.JsonRpcProvider;
    payer: ethers.Signer;
}

interface CancelResult {
    /**
     * Base units of the deposit's token returned to the payer: principal and
     * shield fee, plus the relayer fee when the note was in the same asset.
     */
    refunded: bigint;
    /** The relayer note's asset as the escrow recorded it; 0 for a zero-value note. */
    feeAssetId: AssetId;
    /**
     * Base units of `feeAssetId`'s token returned separately. Nonzero only when
     * the note was paid in another asset (the pool's two-token path).
     */
    feeRefunded: bigint;
    txHash: string;
}

/**
 * The escrow `txHash` created, in the shape a `DepositResult` carries it.
 *
 * For deposits submitted around the SDK wallet (`submitDepositDirect`), so
 * they can be cancelled and checked the same way as a wallet deposit.
 */
export async function escrowOf(provider: ethers.JsonRpcProvider, txHash: string): Promise<DepositEscrow> {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt === null) throw new Error(`escrowOf: no receipt for ${txHash}`);
    const reader = new ethers.Contract(env.maspAddress, MASP_DEPOSIT_ABI, provider);
    const escrowed = parseContractLogs(receipt, reader, "DepositEscrowed");
    if (escrowed.length !== 1) {
        throw new Error(`escrowOf: expected one DepositEscrowed log in ${txHash}, got ${escrowed.length}`);
    }
    const d = escrowed[0].args;
    const cm = hex32(d.cm as string);
    const publicAssetId = assetId(d.publicAssetId as bigint);
    // `submittedAt` in the digest is the block the deposit landed in.
    const submittedAt = receipt.blockNumber;
    return {
        depositId: d.id as bigint,
        native: false,
        asset: publicAssetId,
        commitment: cm,
        cancelInputs: {
            publicIn: d.publicIn as bigint,
            cm,
            cvDep: [d.cvDepX as bigint, d.cvDepY as bigint],
            publicAssetId,
            feeBpsAtSubmit: Number(d.feeBpsAtSubmit),
            payer: evmAddress(d.payer as string),
            submittedAt,
            feeIn: d.feeIn as bigint,
            feeAssetId: assetId(d.feeAssetId as bigint),
            feeCm: hex32(d.feeCm as string),
            feeCvDep: [d.feeCvDepX as bigint, d.feeCvDepY as bigint],
        },
        cancellableAtBlock: submittedAt + (await cancelDelay(provider)),
    };
}

/** Whether deposit `id` still holds an escrow slot: neither flushed nor cancelled. */
export async function isEscrowed(provider: ethers.Provider, id: bigint): Promise<boolean> {
    const masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
    return ((await masp.escrowed(id)) as string) !== ethers.ZeroHash;
}

/**
 * Mine to the escrow's cancel block and cancel it through the raw ABI.
 *
 * The delay is counted in blocks, so it is waited out with `anvil_mine` in a
 * single call rather than in real time. Every service reads the chain by block,
 * so the empty blocks cost the rest of the stack an indexing catch-up and
 * nothing else.
 */
export async function cancelDepositAfterDelay(ctx: CancelCtx, txHash: string): Promise<CancelResult> {
    const escrow = await escrowOf(ctx.provider, txHash);
    await mineUntil(ctx.provider, escrow.cancellableAtBlock);
    const i = escrow.cancelInputs;
    const masp = new ethers.Contract(env.maspAddress, MASP_DEPOSIT_ABI, ctx.payer);
    const tx = await masp.cancelDeposit(
        escrow.depositId,
        i.publicIn,
        i.cm,
        i.cvDep,
        i.publicAssetId,
        i.feeBpsAtSubmit,
        i.payer,
        i.submittedAt,
        [i.feeIn, i.feeAssetId, i.feeCm, i.feeCvDep],
    );
    const canceled = parseContractLogs(await tx.wait(), masp, "DepositCanceled");
    if (canceled.length !== 1) {
        throw new Error(`cancelDeposit: no DepositCanceled log in ${tx.hash}`);
    }
    const c = canceled[0].args;
    return {
        refunded: c.refunded as bigint,
        feeAssetId: assetId(c.feeAssetId as bigint),
        feeRefunded: c.feeRefunded as bigint,
        txHash: tx.hash,
    };
}

/**
 * Deposits a test escrows on purpose, cancelled at the end whatever happened.
 *
 * `track` each unflushable deposit as soon as it lands; `drain` in `afterAll`
 * cancels every one still holding its slot. A test that cancels its own
 * deposit leaves nothing to do, since a cleared slot is skipped, so the happy
 * path pays one `escrowed` read per deposit.
 */
export class EscrowJanitor {
    private readonly txs = new Set<string>();

    constructor(private readonly ctx: CancelCtx) {}

    track(txHash: string): void {
        this.txs.add(txHash);
    }

    async drain(): Promise<void> {
        const failures: string[] = [];
        for (const txHash of this.txs) {
            try {
                const { depositId } = await escrowOf(this.ctx.provider, txHash);
                if (!(await isEscrowed(this.ctx.provider, depositId))) continue;
                await cancelDepositAfterDelay(this.ctx, txHash);
                log(`EscrowJanitor: cancelled deposit ${depositId} left escrowed by ${txHash}`);
            } catch (e) {
                failures.push(`${txHash}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        this.txs.clear();
        if (failures.length > 0) {
            // Thrown: a deposit left escrowed stalls every later file's flush.
            throw new Error(`EscrowJanitor: could not cancel ${failures.length} deposit(s):\n${failures.join("\n")}`);
        }
    }
}

async function cancelDelay(provider: ethers.JsonRpcProvider): Promise<number> {
    const masp = new ethers.Contract(env.maspAddress, MASP_ABI, provider);
    return Number(await masp.cancelDelay());
}

/** Mine straight to `target`, in one call: the blocks are empty and the delay is long. */
async function mineUntil(provider: ethers.JsonRpcProvider, target: number): Promise<void> {
    const now = await provider.getBlockNumber();
    if (now >= target) return;
    await provider.send("anvil_mine", [ethers.toBeHex(target - now)]);
}
