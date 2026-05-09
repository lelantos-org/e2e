// Test-runtime environment. Populated by `src/setup.ts` (vitest
// globalSetup) which boots the testcontainer stack and writes URLs +
// addresses + keys into process.env before any test file is imported.

import { CIRCUITS_BUILD_DIR } from "./constants";

function req(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing env var: ${name}`);
    return v;
}

export const env = {
    relayerUrl: req("RELAYER_URL"),
    fmdUrl: req("FMD_URL"),
    explorerUrl: req("EXPLORER_URL"),
    rpcUrl: req("RPC_URL"),
    maspAddress: req("MASP_ADDRESS"),
    token1: req("TOKEN_1"),
    token2: req("TOKEN_2"),
    chainId: BigInt(req("CHAIN_ID")),
    payerAddress: req("PAYER_ADDRESS"),
    payerKey: req("PAYER_KEY"),
    recipientAddress: req("RECIPIENT_ADDRESS"),
    permit2Address: req("PERMIT2_ADDRESS"),
    circuitsBuild: process.env.CIRCUITS_BUILD ?? CIRCUITS_BUILD_DIR,
};
