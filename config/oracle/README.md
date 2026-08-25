# Price oracle stub

`CoinbaseOracle` fetches `{base_url}/prices/{BASE}-{QUOTE}/{spot|buy}` and reads
`data.amount`, so serving that tree from a static file server gives the relayer
a real HTTP oracle with no network egress and no moving prices. A live feed
would make every fee assertion depend on the market at the moment CI ran.

`price(native, quote)` is **quote units per 1 native**, and the native symbol is
`ETH`, so `ETH-USD/spot` is "what one ETH is worth in USD". Every fee token
quotes in USD, which is why this is the only pair here — the relayer asks for
one pair per accepted token.

## Why the price is absurd

The value is chosen for size, not realism. A shielded fee is

    gas × gasPrice × price × 10^tokenDec / 10^18   (base units)

and dividing by the asset's scale gives circuit units. At ~600k gas and 1 gwei
that is `6.6e14 × price` base units, so with 18-decimal assets at scale 1e10 a
*realistic* ETH/USD would price one transfer at tens of thousands of circuit
units — more than the whole balance these tests deposit. Every test would then
fail on affordability rather than on the thing it means to check.

The value below lands a fee at roughly 1-3 circuit units against test amounts
of 10-105, which is small enough to afford and large enough that a test
asserting "the fee was actually taken" is not asserting against zero.

Tests still derive the fee they expect rather than hardcoding it — gas moves
between runs. See `feePaid` in `src/wait.ts`.
