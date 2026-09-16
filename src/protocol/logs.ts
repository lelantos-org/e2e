// Typed event extraction from a receipt.
//
// Outside `harness.ts` so the testkit can use it: `harness` re-exports the
// testkit, and a testkit module importing back from `harness` closes an ESM
// import cycle.

import { ethers } from "ethers";

import { BUNDLE_ITEM_EVENTS_ABI, BUNDLER_ABI } from "./abi.js";

// Logs from foreign ABIs are skipped; `parseLog` throws on those.
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
            // not this contract's ABI
        }
    }
    return out;
}

/** The entry point one operation in a bundle went through. Spelled as the relayer's queue reports it. */
export type BundleItemKind = "flush" | "transfer" | "withdraw" | "withdrawNative" | "swap";

/**
 * One tree-advancing operation within a transaction.
 *
 * A relayer lands several operations in one `Bundler.execute`, so a receipt's
 * `RootAdvanced` count, `DepositFlushed` count and leaf delta describe the whole
 * bundle rather than any one of them. Assertions about an operation read its
 * item instead.
 */
export interface BundleItem {
    kind: BundleItemKind;
    /** Position within the transaction, from 0. */
    index: number;
    startIndex: bigint;
    inserted: bigint;
    oldRoot: string;
    newRoot: string;
    /** A flush's deposits; empty for a spend. */
    depositIds: bigint[];
    /** A spend's four nullifiers, lowercase hex; empty for a flush. */
    nullifiers: string[];
    /**
     * Lowercase hex, in emission order: a spend's six output commitments, or a
     * flush's depositor notes. `DepositFlushed` carries only the depositor's
     * leaf, so a flush has half as many as it inserted.
     */
    cms: string[];
    /** The pool's `AssetMoved` for a withdraw leg: withdraw, withdrawNative, swap. */
    assetMoved?: ethers.Result;
    /** `NativeAdapter.NativeWithdrawn`, on a withdrawNative. */
    nativeWithdrawn?: ethers.Result;
    /** `SwapWrapper.SwapExecuted`, on a swap. */
    swapExecuted?: ethers.Result;
    /** `SwapWrapper.SwapRefunded`, on a swap whose venue leg failed; its deposit is the refund. */
    swapRefunded?: ethers.Result;
    /** The swap's output deposit, escrowed here and flushed by a later operation. */
    escrowedDepositId?: bigint;
    /** Inclusive `logIndex` bounds of the logs this walker assigned to the item. */
    logRange: [number, number];
}

/** Where each contract `bundleItems` reads lives. Absent adapters are never matched. */
export interface BundleEmitters {
    masp: string;
    nativeAdapter?: string;
    swapWrapper?: string;
}

/**
 * Split a receipt into its operations, in execution order.
 *
 * Walks the logs by `logIndex`, keeping the pool's and the two adapters' and
 * skipping every other emitter (tokens, WETH, the Bundler). The pool emits in a
 * fixed order per entry point, pinned by `Bundler.t.sol`'s
 * `test_execute_mixedBundle_logLayout`:
 *
 *     flush           DepositFlushed×n, RootAdvanced
 *     transfer        NullifierConsumed×4, RootAdvanced, NotePayload×6
 *     withdraw        NullifierConsumed×4, RootAdvanced, AssetMoved, NotePayload×6
 *     withdrawNative  as withdraw, then the adapter's NativeWithdrawn
 *     swap            as withdraw, then DepositEscrowed, AssetMoved, SwapExecuted
 *                     or, refunded, SwapRefunded
 *
 * A flush's leaves lead its root and a spend's root leads its leaves, so an
 * item opens at its first `DepositFlushed` or `NullifierConsumed` and every
 * later log up to the next opener belongs to it. Throws when the logs do not
 * follow that grammar, or when consecutive items do not chain — each must start
 * at the leaf count and root the previous one left — since either means the
 * walker and the contracts disagree and every assertion built on it is suspect.
 */
export function bundleItems(receipt: ethers.TransactionReceipt, at: BundleEmitters): BundleItem[] {
    const iface = new ethers.Interface(BUNDLE_ITEM_EVENTS_ABI);
    const is = (log: ethers.Log, addr: string | undefined) =>
        addr !== undefined && log.address.toLowerCase() === addr.toLowerCase();
    const where = (log: ethers.Log) => `${receipt.hash} log ${log.index}`;

    const items: BundleItem[] = [];
    // Logs seen since the last item closed that open the next one.
    let flushed: { id: bigint; cm: string }[] = [];
    let nullifiers: string[] = [];
    let firstLog: number | undefined;
    let current: BundleItem | undefined;

    for (const log of [...receipt.logs].sort((a, b) => a.index - b.index)) {
        const fromMasp = is(log, at.masp);
        if (!fromMasp && !is(log, at.nativeAdapter) && !is(log, at.swapWrapper)) continue;
        const parsed = iface.parseLog(log);
        if (parsed === null) continue;

        switch (fromMasp ? parsed.name : `adapter:${parsed.name}`) {
            case "DepositFlushed":
                firstLog ??= log.index;
                flushed.push({ id: parsed.args.id as bigint, cm: hex32(parsed.args.cm) });
                break;
            case "NullifierConsumed":
                firstLog ??= log.index;
                nullifiers.push(hex32(parsed.args.nf));
                break;
            case "RootAdvanced": {
                if ((flushed.length === 0) === (nullifiers.length === 0)) {
                    throw new Error(
                        `${where(log)}: RootAdvanced after ${flushed.length} DepositFlushed and ` +
                            `${nullifiers.length} NullifierConsumed; expected exactly one kind`,
                    );
                }
                if (nullifiers.length !== 0 && nullifiers.length !== 4) {
                    throw new Error(`${where(log)}: spend with ${nullifiers.length} nullifiers`);
                }
                current = {
                    kind: flushed.length > 0 ? "flush" : "transfer",
                    index: items.length,
                    startIndex: parsed.args.startIndex as bigint,
                    inserted: parsed.args.inserted as bigint,
                    oldRoot: hex32(parsed.args.oldRoot),
                    newRoot: hex32(parsed.args.newRoot),
                    depositIds: flushed.map((f) => f.id),
                    nullifiers,
                    cms: flushed.map((f) => f.cm),
                    logRange: [firstLog!, log.index],
                };
                items.push(current);
                flushed = [];
                nullifiers = [];
                firstLog = undefined;
                break;
            }
            case "AssetMoved":
                if (current === undefined || current.kind === "flush") {
                    throw new Error(`${where(log)}: AssetMoved outside a spend`);
                }
                // The first is the withdraw leg, ahead of the notes; a swap's
                // second is its output deposit's pull, after the escrow.
                if (current.escrowedDepositId === undefined) {
                    current.kind = "withdraw";
                    current.assetMoved = parsed.args;
                }
                current.logRange[1] = log.index;
                break;
            case "NotePayload":
                if (current === undefined || current.kind === "flush") {
                    throw new Error(`${where(log)}: NotePayload outside a spend`);
                }
                current.cms.push(hex32(parsed.args.cm));
                current.logRange[1] = log.index;
                break;
            case "DepositEscrowed":
                // Only a swap escrows inside a tree-advancing operation.
                if (current === undefined || current.kind !== "withdraw") {
                    throw new Error(`${where(log)}: DepositEscrowed outside a withdraw leg`);
                }
                current.escrowedDepositId = parsed.args.id as bigint;
                current.logRange[1] = log.index;
                break;
            case "adapter:NativeWithdrawn":
                if (current === undefined || current.kind !== "withdraw") {
                    throw new Error(`${where(log)}: NativeWithdrawn outside a withdraw`);
                }
                current.kind = "withdrawNative";
                current.nativeWithdrawn = parsed.args;
                current.logRange[1] = log.index;
                break;
            case "adapter:SwapExecuted":
            case "adapter:SwapRefunded":
                if (current === undefined || current.escrowedDepositId === undefined) {
                    throw new Error(`${where(log)}: ${parsed.name} without its escrow`);
                }
                current.kind = "swap";
                current[parsed.name === "SwapExecuted" ? "swapExecuted" : "swapRefunded"] = parsed.args;
                current.logRange[1] = log.index;
                break;
            // Anything else from these contracts carries no operation boundary.
        }
    }
    if (flushed.length > 0 || nullifiers.length > 0) {
        throw new Error(`${receipt.hash}: logs end inside an operation with no RootAdvanced`);
    }

    for (let k = 1; k < items.length; k++) {
        const [prev, next] = [items[k - 1], items[k]];
        if (next.startIndex !== prev.startIndex + prev.inserted || next.oldRoot !== prev.newRoot) {
            throw new Error(
                `${receipt.hash}: item ${k} (${next.kind}) starts at ${next.startIndex} on ` +
                    `${next.oldRoot}, but item ${k - 1} (${prev.kind}) left ` +
                    `${prev.startIndex + prev.inserted} on ${prev.newRoot}`,
            );
        }
    }
    return items;
}

/** How far a `Bundler.execute` got, from the Bundler's own events. */
export interface BundleOutcome {
    executed: bigint;
    total: bigint;
    /** The item it stopped at, if it stopped. */
    failed?: { index: bigint; reason: string };
}

/** Read `BundleExecuted` and any `BundleItemFailed` off `bundler`'s logs, or throw if there is none. */
export function bundleOutcome(receipt: ethers.TransactionReceipt, bundler: string): BundleOutcome {
    const iface = new ethers.Interface(BUNDLER_ABI);
    const own = receipt.logs
        .filter((l) => l.address.toLowerCase() === bundler.toLowerCase())
        .map((l) => iface.parseLog(l))
        .filter((l): l is ethers.LogDescription => l !== null);
    const executed = own.filter((l) => l.name === "BundleExecuted");
    if (executed.length !== 1) {
        throw new Error(`${receipt.hash}: ${executed.length} BundleExecuted logs from ${bundler}`);
    }
    const failed = own.find((l) => l.name === "BundleItemFailed");
    return {
        executed: executed[0].args.executed as bigint,
        total: executed[0].args.total as bigint,
        ...(failed
            ? { failed: { index: failed.args.index as bigint, reason: failed.args.reason as string } }
            : {}),
    };
}

function hex32(v: unknown): string {
    return ethers.toBeHex(v as ethers.BigNumberish, 32).toLowerCase();
}
