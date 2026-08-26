// What a deployed stack is, as data.
//
// Types only, in their own module so that `services.ts` — which needs a
// `SwapAddresses` to build the relayer and metaquoter environments — does not
// import from `stack.ts`, which imports `services.ts` to start them. That keeps
// the container specs upstream of the orchestrator that runs them.

export interface SwapAddresses {
    univ3Quoter: string;
    univ3Adapter: string;
    mockSwapRouter: string;
    wrapper: string;
}

export interface Addresses {
    verifier: string;
    treeUpdateVerifier: string;
    masp: string;
    tokens: Record<number, string>;
    wrappedNative?: string;
    nativeAdapter?: string;
    permit2: string;
    swap?: SwapAddresses;
}

export interface Urls {
    rpc: string;
    relayer: string;
    fmd: string;
    /** Emitted by `npm run up` for manual queries; no test reads it. */
    explorer: string;
    metaquoter?: string;
}

export interface StackEnv extends Urls {
    chainId: string;
    masp: string;
    tokens: Record<number, string>;
    payerAddress: string;
    payerKey: string;
    recipientAddress: string;
    permit2: string;
    nativeAdapter?: string;
    swap?: SwapAddresses;
}

/**
 * Look up a deployed token address by asset id.
 *
 * The registry and the deploy are separate sources. An asset the suite knows
 * about but the script never deployed would otherwise reach the relayer as an
 * empty address and surface as a fee quote for token 0x0.
 */
export function requireToken(tokens: Record<number, string>, assetId: number): string {
    const addr = tokens[assetId];
    if (addr === undefined) {
        throw new Error(`no deployed token for asset ${assetId}; cannot price fees in it`);
    }
    return addr;
}
