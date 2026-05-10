// Test-runtime environment. Populated by `src/setup.ts` (vitest
// globalSetup) which boots the testcontainer stack and writes URLs +
// addresses + keys into process.env before any test file is imported.

import { CIRCUITS_BUILD_DIR } from "./constants";

function req(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing env var: ${name}`);
    return v;
}

function opt(name: string): string | undefined {
    return process.env[name] || undefined;
}

/// Lazy accessor: throws iff the swap stack was not deployed in this run.
/// Use from swap.test.ts; legacy tests that don't need swap addresses
/// must NOT call this.
function reqSwap<T>(getter: () => T | undefined, name: string): T {
    const v = getter();
    if (v === undefined) {
        throw new Error(
            `missing env var: ${name} — set E2E_SKIP_SWAP=0 (default) and rerun setup`,
        );
    }
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

    // Optional — populated only when SWAP_ENABLED=true at deploy.
    metaquoterUrl: () => reqSwap(() => opt("METAQUOTER_URL"), "METAQUOTER_URL"),
    swap: {
        univ3Quoter: () => reqSwap(() => opt("UNIV3_QUOTER_ADDRESS"), "UNIV3_QUOTER_ADDRESS"),
        univ3Adapter: () => reqSwap(() => opt("UNIV3_ADAPTER_ADDRESS"), "UNIV3_ADAPTER_ADDRESS"),
        mockSwapRouter: () => reqSwap(() => opt("MOCK_SWAP_ROUTER_ADDRESS"), "MOCK_SWAP_ROUTER_ADDRESS"),
        wrapper: () => reqSwap(() => opt("SWAP_WRAPPER_ADDRESS"), "SWAP_WRAPPER_ADDRESS"),
    },
};
