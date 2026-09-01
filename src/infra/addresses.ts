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
    univ4Quoter: string;
    univ4Adapter: string;
    mockUniversalRouter: string;
    wrapper: string;
}

/**
 * One `DeployTestYield` triple, keyed by the *yield* asset id it was
 * registered under.
 *
 * `token` is the same ERC-20 the plain id already points at — a yield id is
 * registered alongside its plain id, not in place of it, and the two differ
 * only in the venue binding. It is carried anyway rather than derived, because
 * the script logs it: an offset that ever stops matching shows up here as a
 * mismatched address instead of silently pairing the wrong vault.
 */
export interface YieldAsset {
    token: string;
    vault: string;
    venue: string;
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
    /** Absent when the stack was brought up with `E2E_SKIP_YIELD=1`. */
    yield?: Record<number, YieldAsset>;
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
    yield?: Record<number, YieldAsset>;
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
