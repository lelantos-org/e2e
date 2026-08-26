// The asset registry the stack deploys, mirrored test-side.
//
// Mirrors `contracts/test/fixtures/asset_registry.json`, so a test can say
// `ASSETS.WETH` instead of `1n` and get the right scale with it. It is a copy:
// a registry change that lands in the fixture and not here surfaces as a
// balance assertion wrong by a factor of 10^10, not as a load error.
//
// Every other view of the registry — the ids, the scales, the relayer's fee
// tokens — is derived from `REGISTRY` below. The id is the join between them,
// and parallel tables keyed by it drift one row at a time.

import { type AssetId, assetId } from "@lelantos-org/sdk";

/**
 * Every asset the deploy registers.
 *
 * `scale` is the MASP scale (circuit units → base units); `decimals` is the
 * ERC-20's. They are distinct: the relayer prices a gas quote into base units
 * using `decimals`, and the wallet converts to circuit units using `scale`.
 */
const REGISTRY = [
    {
        id: 1,
        key: "WETH",
        // WETH9 mock: no public `mint(address,uint256)`; use `setupWeth`.
        symbol: "WETH",
        decimals: 18,
        scale: 10_000_000_000n,
    },
    {
        id: 2,
        key: "MDAI",
        // MockERC20 with a public mint; default for the fee/scale helpers.
        symbol: "mDAI",
        decimals: 18,
        scale: 10_000_000_000n,
    },
    {
        id: 3,
        key: "MWBTC",
        // MockERC20, 8 decimals, so scale is 1.
        symbol: "mWBTC",
        decimals: 8,
        scale: 1n,
    },
] as const;

type RegistryEntry = (typeof REGISTRY)[number];

/**
 * Asset ids by name, branded at the source: the SDK wallet surface takes
 * `AssetId`, and the brand widens back to `bigint` for the local scale/fee
 * helpers and for `bundleCommon`.
 */
export const ASSETS = Object.fromEntries(
    REGISTRY.map((a) => [a.key, assetId(BigInt(a.id))]),
) as { readonly [K in RegistryEntry["key"]]: AssetId };

/** Default asset for `feeFor` / `baseAmt` / `withFee`. */
export const ASSET: AssetId = ASSETS.MDAI;

/**
 * Oracle quote symbol for every fee token.
 *
 * The relayer asks the oracle for one `{native}-{quote}` pair per accepted
 * token, so each distinct value here needs a file under
 * `config/oracle/prices/`. All tokens quote in USD to keep that to one pair;
 * see that directory's README.
 */
export const FEE_QUOTE_SYMBOL = "USD";

/**
 * The assets the relayer accepts as a shielded fee, mirrored into
 * `accepted_fee_tokens` at boot.
 *
 * Every registered asset is included: a payer can only pay the fee in the asset
 * they are already moving, so an asset left out is one no test could transact
 * in.
 */
export const FEE_TOKENS = REGISTRY.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    decimals: a.decimals,
    quoteSymbol: FEE_QUOTE_SYMBOL,
}));

export function scaleFor(asset: bigint): bigint {
    const entry = REGISTRY.find((a) => BigInt(a.id) === asset);
    if (entry === undefined) throw new Error(`scaleFor: unknown asset id ${asset}`);
    return entry.scale;
}
