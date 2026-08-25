// The relayer's shielded fee identity.
//
// Turning on `shielded_fee_address` makes the relayer charge for both paths at
// once: every spend must carry an output note addressed here, and every
// deposit's second leaf must be a note this identity can decrypt and spend.
// A relayer that cannot read its own fee note simply declines to flush, so the
// address and the viewing key have to describe the same identity — the relayer
// refuses to boot otherwise (`FeeRecipient::new`).
//
// # These are committed on purpose
//
// They are a *test* identity for a throwaway anvil, and pinning them makes the
// stack reproducible: the relayer's config, the address wallets pay, and the
// wallet the suite uses to check the fee arrived are all the same identity by
// construction rather than by three derivations agreeing at runtime.
//
// `ivk` is decrypt-only — it recognises notes and reads their value, and
// confers no authority to move them. `RELAYER_FEE_NSK` is the spending key and
// is here only so the suite can build a wallet that *spends* the collected
// fees, proving the notes are real. Nothing outside this repo should ever see
// an nsk in source.

/**
 * nsk of the identity the relayer is paid at.
 *
 * Distinct from every entry in `TEST_NSK`: a wallet sharing it would scan the
 * relayer's fee notes as its own and report a balance it cannot spend.
 */
export const RELAYER_FEE_NSK = 0xfee_1_a1_e40n;

/**
 * bech32m address wallets send the fee note to, and the decrypt-only viewing
 * key the relayer is configured with.
 *
 * Regenerate with `buildSpendingKey(P, J, RELAYER_FEE_NSK)` and
 * `encodeAddress(J, pk_d, pk, ck)` — `tests/shielded-fee.test.ts` re-derives
 * both and fails if either drifts from the nsk above.
 */
export const RELAYER_FEE_ADDRESS =
    "lelantos1pt5x36h9te4nhc5k5dx7he4m55p9l6gl6u8t3wxkhxvx4d89c6q2qpxmsqj0ha34jkaupskyemvmpwempecmjjpcd0kswwe62phz2qcj7kh0q02j4akatg9xchazr4td8eht8ul4lzdr6k346fzsaxtf3ccnr3c9";

export const RELAYER_FEE_IVK =
    "0x2a60ff35984e4c2013a03867a433d5d5272df218436cc27557fddc5231fcd99d";
