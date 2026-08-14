// Populated by `src/setup.ts` (vitest globalSetup) before test files import.

import { type EvmAddress, evmAddress } from "@lelantos-org/sdk";

function req(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing env var: ${name}`);
    return v;
}

// The SDK's wallet surface takes branded addresses. Brand at the boundary so
// a malformed env var fails at import rather than deep inside a signer, and
// so call sites that only need a plain string still work (the brand widens).
function reqAddr(name: string): EvmAddress {
    return evmAddress(req(name));
}

function opt(name: string): string | undefined {
    return process.env[name] || undefined;
}

// Throws iff the swap stack was not deployed in this run.
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
    maspAddress: reqAddr("MASP_ADDRESS"),
    token1: reqAddr("TOKEN_1"),
    token2: reqAddr("TOKEN_2"),
    token3: reqAddr("TOKEN_3"),
    chainId: BigInt(req("CHAIN_ID")),
    payerAddress: reqAddr("PAYER_ADDRESS"),
    payerKey: req("PAYER_KEY"),
    recipientAddress: reqAddr("RECIPIENT_ADDRESS"),
    permit2Address: reqAddr("PERMIT2_ADDRESS"),
    // Deployed only when the stack includes a wrapped-native token. Native
    // deposits and `withdrawEth` both run through it; the pool is ERC-20 only.
    nativeAdapterAddress: opt("NATIVE_ADAPTER_ADDRESS"),

    // Populated only when SWAP_ENABLED=true at deploy.
    metaquoterUrl: () => reqSwap(() => opt("METAQUOTER_URL"), "METAQUOTER_URL"),
    swap: {
        univ3Quoter: () => evmAddress(reqSwap(() => opt("UNIV3_QUOTER_ADDRESS"), "UNIV3_QUOTER_ADDRESS")),
        univ3Adapter: () => evmAddress(reqSwap(() => opt("UNIV3_ADAPTER_ADDRESS"), "UNIV3_ADAPTER_ADDRESS")),
        mockSwapRouter: () => evmAddress(reqSwap(() => opt("MOCK_SWAP_ROUTER_ADDRESS"), "MOCK_SWAP_ROUTER_ADDRESS")),
        wrapper: () => evmAddress(reqSwap(() => opt("SWAP_WRAPPER_ADDRESS"), "SWAP_WRAPPER_ADDRESS")),
    },
};
