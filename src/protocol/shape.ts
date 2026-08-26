// Circuit and tree geometry, pinned to artifacts outside this repo. Change one
// and the verifier, the contracts or the asset registry stops agreeing with it.
// Kept as a complete reference table, so entries the suite does not currently
// read are still listed.

// Must match `circuits/4x4.circom` `Transact(N_IN, N_OUT, GAMMA, DEPTH)`.
export const TREE_DEPTH = 10;

// Circuit arity. `PubInputs.TRANSACT_IN` / `TRANSACT_OUT` in the contracts and
// `TRANSACT_4X4` in the SDK; all three must agree or the verifier rejects.
export const N_IN = 4;
export const N_OUT = 4;

// FMD γ. False-positive rate = 2^-γ. Must match asset registry + circuit.
export const FMD_GAMMA = 5;
