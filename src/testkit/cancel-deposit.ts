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
// deposits of every test file that runs afterwards.

import { ethers } from "ethers";

import { MASP_DEPOSIT_ABI } from "../protocol/abi.js";
import { parseContractLogs } from "../protocol/logs.js";

export interface CancelResult {
    /** Base units returned to the payer: principal, shield fee and relayer fee. */
    refunded: bigint;
    txHash: string;
}

/**
 * Mine past `cancelDelay` and cancel the deposit submitted in `txHash`.
 *
 * The delay is counted in blocks, so it is waited out with `anvil_mine` in a
 * single call rather than in real time. Every service reads the chain by block,
 * so the empty blocks cost the rest of the stack an indexing catch-up and
 * nothing else.
 */
export async function cancelDepositAfterDelay(args: {
    provider: ethers.JsonRpcProvider;
    payer: ethers.Signer;
    maspAddress: string;
    txHash: string;
}): Promise<CancelResult> {
    const { provider, payer, maspAddress, txHash } = args;
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt === null) throw new Error(`cancelDeposit: no receipt for ${txHash}`);

    const reader = new ethers.Contract(maspAddress, MASP_DEPOSIT_ABI, provider);
    const escrowed = parseContractLogs(receipt, reader, "DepositEscrowed");
    if (escrowed.length !== 1) {
        throw new Error(
            `cancelDeposit: expected one DepositEscrowed log in ${txHash}, got ${escrowed.length}`,
        );
    }
    const d = escrowed[0].args;
    // `submittedAt` in the digest is the block the deposit landed in.
    const submittedAt = receipt.blockNumber;

    await mineUntil(provider, submittedAt + Number(await cancelDelay(provider, maspAddress)));

    const masp = new ethers.Contract(maspAddress, MASP_DEPOSIT_ABI, payer);
    const tx = await masp.cancelDeposit(
        d.id,
        d.publicIn,
        d.cm,
        [d.cvDepX, d.cvDepY],
        d.publicAssetId,
        d.feeBpsAtSubmit,
        d.payer,
        submittedAt,
        [d.feeIn, d.feeCm, [d.feeCvDepX, d.feeCvDepY]],
    );
    const canceled = parseContractLogs(await tx.wait(), masp, "DepositCanceled");
    if (canceled.length !== 1) {
        throw new Error(`cancelDeposit: no DepositCanceled log in ${tx.hash}`);
    }
    return { refunded: canceled[0].args.amount as bigint, txHash: tx.hash };
}

async function cancelDelay(
    provider: ethers.JsonRpcProvider,
    maspAddress: string,
): Promise<bigint> {
    const masp = new ethers.Contract(
        maspAddress,
        ["function cancelDelay() view returns (uint32)"],
        provider,
    );
    return BigInt(await masp.cancelDelay());
}

/** Mine straight to `target`, in one call: the blocks are empty and the delay is long. */
async function mineUntil(provider: ethers.JsonRpcProvider, target: number): Promise<void> {
    const now = await provider.getBlockNumber();
    if (now >= target) return;
    await provider.send("anvil_mine", [ethers.toBeHex(target - now)]);
}
