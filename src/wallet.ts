import { ethers } from "ethers";

import {
    EthersChainAdapter,
    type Field,
    InMemoryNoteStore,
    nodeWallet,
    type Wallet,
} from "@lelantos-org/sdk";

import { RELAYER } from "./accounts.js";
import { TREE_DEPTH } from "./constants.js";
import { env } from "./env.js";
import type { Harness } from "./harness.js";
import { PROVER_PATHS } from "./harness.js";

export interface CreateWalletOpts {
    signer?: ethers.Signer;
    noteStore?: InMemoryNoteStore;
}

// Each test file uses a distinct prefix; files share one anvil + FMD index,
// so colliding NSKs leak notes across tests.
export const TEST_NSK = {
    fullFlow:       { alice: 0xff_a1ce_a11c0n, bob: 0xff_b0b_b0b00n },
    doubleSpend:    { alice: 0xdd_a1ce_a11c0n, bob: 0xdd_b0b_b0b00n },
    clientResync:   { alice: 0xcc_a1ce_a11c0n, bob: 0xcc_b0b_b0b00n },
    twoInputMerge:  { alice: 0x22_a1ce_a11c0n, bob: 0x22_b0b_b0b00n },
    multiAsset:     { alice: 0xaa_a1ce_a11c0n },
    withdrawNative: { alice: 0xee_a1ce_a11c0n },
    batchFlush:     { alice: 0xbf_a1ce_a11c0n },
    swap:           { alice: 0x55_a1ce_a11c0n },
    negExpired:     { alice: 0xe1_a1ce_a11c0n },
    negZeroValue:   { alice: 0xe2_a1ce_a11c0n },
    edgeConcurrent: { alice: 0xed_a1ce_a11c0n },
} as const;

export async function createTestWallet(
    h: Harness,
    nsk: Field,
    opts: CreateWalletOpts = {},
): Promise<Wallet> {
    const signer = opts.signer ?? h.payer;
    const chain = new EthersChainAdapter({
        rpcUrl: env.rpcUrl,
        signer,
        maspAddress: env.maspAddress,
        permit2Address: env.permit2Address,
        chainId: env.chainId,
    });
    return nodeWallet({
        keys: { type: "nsk", nsk },
        config: {
            chainId: env.chainId,
            treeDepth: TREE_DEPTH,
            relayerAddress: RELAYER.address,
            chain,
            fmdUrl: env.fmdUrl,
            relayerUrl: env.relayerUrl,
            proverPaths: PROVER_PATHS,
            noteStore: opts.noteStore ?? new InMemoryNoteStore(),
        },
    });
}
