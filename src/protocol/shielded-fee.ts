// The relayer's shielded fee identity.
//
// Setting `shielded_fee_address` enables charging on both paths: every spend
// must carry an output note addressed here, and every deposit's second leaf
// must be a note this identity can decrypt and spend. A relayer that cannot
// read its own fee note declines to flush, so the address and the viewing key
// must describe the same identity — the relayer refuses to boot otherwise
// (`FeeRecipient::new`).
//
// These constants are committed. They are a test identity for a
// throwaway anvil, and pinning them makes the stack reproducible: the relayer's
// config, the address wallets pay, and the wallet the suite uses to check the
// fee arrived are one identity by construction rather than by three
// derivations agreeing at runtime.
//
// `ivk` is decrypt-only: it recognises notes and reads their value, and confers
// no authority to move them. `RELAYER_FEE_NSK` is the spending key, present so
// the suite can build a wallet that spends the collected fees and prove the
// notes are real.

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
 * Regenerate with `buildSpendingKey(P, RELAYER_FEE_NSK)` and
 * `addressFromViewingKey(P, J, keys)`: the address at diversifier index 0, the
 * only one the relayer credits. `tests/shielded-fee.test.ts` re-derives both
 * and fails if either drifts from the nsk above.
 */
export const RELAYER_FEE_ADDRESS =
    "lelantos12nks6y88842ua99jy56n6ng02sdktcqmzzwhgpd0uuvmyzp8yzxhuc2zazlcm8kyy32hsz500rkznrrtdk4xj26kz2gg9axktesvsfhjx0h365rtj9h36wgw5xknf7swcglwq4uqw9aflmcq88rfssrflgynn8ccuyutmz886889at5hzykqsexr5w";

export const RELAYER_FEE_IVK =
    "0x2a60ff35984e4c2013a03867a433d5d5272df218436cc27557fddc5231fcd99d";
