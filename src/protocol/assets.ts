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
 * Every registry id by name, branded at the source: the SDK wallet surface
 * takes `AssetId`, and the brand widens back to `bigint` for the local
 * scale/fee helpers and for `bundleCommon`.
 */
type IdsByKey = { readonly [K in RegistryEntry["key"]]: AssetId };

/** The registry's ids shifted by `offset`, keyed by name. */
function idsByKey(offset: bigint): IdsByKey {
    return Object.fromEntries(
        REGISTRY.map((a) => [a.key, assetId(BigInt(a.id) + offset)]),
    ) as IdsByKey;
}

export const ASSETS = idsByKey(0n);

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

/**
 * Plain id → yield id shift, mirroring `DeployTestYield`'s `YIELD_ID_OFFSET`
 * default of the fixture's asset count (1,2,3 -> 4,5,6).
 *
 * A yield id is registered *alongside* its plain id, never in place of it: the
 * plain id stays risk-free custody, the yield id lends through an
 * `ERC4626Venue`, and a depositor opts in by choosing an id. Both therefore
 * share one ERC-20 and one `scale`, and differ only in the venue binding.
 *
 * Mirrored rather than read back for the same reason `REGISTRY` is: the deploy
 * publishes the real ids in `YIELD_ASSET_IDS`, and a shift that stopped
 * matching would surface there as a lookup for an id the script never
 * registered.
 */
export const YIELD_ID_OFFSET = BigInt(REGISTRY.length);

/**
 * Yield asset ids by the same name as their plain counterparts, so a test can
 * say `YIELD_ASSETS.MDAI` for the lending id and `ASSETS.MDAI` for the plain
 * one.
 */
export const YIELD_ASSETS = idsByKey(YIELD_ID_OFFSET);

const YIELD_IDS: ReadonlySet<bigint> = new Set(
    REGISTRY.map((a) => BigInt(a.id) + YIELD_ID_OFFSET),
);

/** Whether `asset` is one of the deploy's yield ids rather than a plain one. */
export function isYieldAsset(asset: bigint): boolean {
    return YIELD_IDS.has(asset);
}

/**
 * The plain id a yield id shadows; the id itself when it is already plain.
 *
 * The two share an ERC-20 and a scale, so every per-asset table keyed by the
 * plain id — `REGISTRY`, the deployed `tokens` map, the relayer's fee tokens —
 * is reached through here rather than duplicated per yield id.
 */
export function plainAssetOf(asset: bigint): bigint {
    return isYieldAsset(asset) ? asset - YIELD_ID_OFFSET : asset;
}

export function scaleFor(asset: bigint): bigint {
    const plain = plainAssetOf(asset);
    const entry = REGISTRY.find((a) => BigInt(a.id) === plain);
    if (entry === undefined) throw new Error(`scaleFor: unknown asset id ${asset}`);
    return entry.scale;
}
