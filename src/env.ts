// Stack coordinates, published by `src/setup.ts` (vitest globalSetup) before
// any test file is imported.

import { type EvmAddress, evmAddress } from "@lelantos-org/sdk";

function req(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing env var: ${name}`);
    return v;
}

// The SDK's wallet surface takes branded addresses. Branding at the boundary
// makes a malformed env var fail at import rather than deep inside a signer,
// and the brand widens back to `string` for call sites that need a plain one.
function reqAddr(name: string): EvmAddress {
    return evmAddress(req(name));
}

function opt(name: string): string | undefined {
    return process.env[name] || undefined;
}

/**
 * Read a var that exists only when an optional deploy step ran, naming the
 * flag that turns that step off.
 *
 * The two optional stacks fail the same way — a test written against one runs
 * fine until someone skips it — so the message points at the switch rather
 * than at the missing variable alone.
 */
function reqStep(name: string, skipFlag: string): string {
    const v = opt(name);
    if (v === undefined) {
        throw new Error(`missing env var: ${name} — set ${skipFlag}=0 (default) and rerun setup`);
    }
    return v;
}

const reqSwap = (name: string): string => reqStep(name, "E2E_SKIP_SWAP");
const reqYield = (name: string): string => reqStep(name, "E2E_SKIP_YIELD");

/** One deployed yield asset, as the tests see it. */
export interface YieldAssetEnv {
    /** Yield asset id — the `asset` argument on every wallet method. */
    id: bigint;
    /** The ERC-20 underneath it, shared with the plain id it shadows. */
    token: EvmAddress;
    /** MockERC4626 the venue lends into; `earn`/`lose` move the index here. */
    vault: EvmAddress;
    /** ERC4626Venue the pool is bound to for this id. */
    venue: EvmAddress;
}

export const env = {
    relayerUrl: req("RELAYER_URL"),
    fmdUrl: req("FMD_URL"),
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
    // Present only when the stack includes a wrapped-native token. Native
    // deposits and `withdrawEth` both run through it; the pool is ERC-20 only.
    nativeAdapterAddress: opt("NATIVE_ADAPTER_ADDRESS"),

    // Present only when SWAP_ENABLED=true at deploy.
    metaquoterUrl: () => reqSwap("METAQUOTER_URL"),
    swap: {
        univ3Quoter: () => evmAddress(reqSwap("UNIV3_QUOTER_ADDRESS")),
        univ3Adapter: () => evmAddress(reqSwap("UNIV3_ADAPTER_ADDRESS")),
        mockSwapRouter: () => evmAddress(reqSwap("MOCK_SWAP_ROUTER_ADDRESS")),
        univ4Quoter: () => evmAddress(reqSwap("UNIV4_QUOTER_ADDRESS")),
        univ4Adapter: () => evmAddress(reqSwap("UNIV4_ADAPTER_ADDRESS")),
        wrapper: () => evmAddress(reqSwap("SWAP_WRAPPER_ADDRESS")),
    },

    // Present only when the stack ran DeployTestYield (default; E2E_SKIP_YIELD=1
    // turns it off).
    yield: {
        /** Every registered yield id, ascending. */
        ids: (): bigint[] =>
            reqYield("YIELD_ASSET_IDS")
                .split(",")
                .map(BigInt)
                .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),

        /** The triple registered under `id`. */
        asset: (id: bigint): YieldAssetEnv => ({
            id,
            token: evmAddress(reqYield(`YIELD_TOKEN_${id}`)),
            vault: evmAddress(reqYield(`YIELD_VAULT_${id}`)),
            venue: evmAddress(reqYield(`YIELD_VENUE_${id}`)),
        }),
    },
};
