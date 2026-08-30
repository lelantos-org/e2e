// Circuit and tree geometry, pinned to artifacts outside this repo. Change one
// and the verifier, the contracts or the asset registry stops agreeing with it.
// Kept as a complete reference table, so entries the suite does not currently
// read are still listed.

// Must match `circuits/4x6.circom` `Transact(N_IN, N_OUT, GAMMA, DEPTH)`, and
// `CommitmentTree.EMPTY_ROOT` in the contracts, which is the arity-4 empty
// subtree at this depth. Widened from 10 in circuits 0.12.0.
export const TREE_DEPTH = 11;

// Circuit arity. `PubInputs.TRANSACT_IN` / `TRANSACT_OUT` in the contracts and
// `TRANSACT_4X6` in the SDK; all three must agree or the verifier rejects.
export const N_IN = 4;
export const N_OUT = 6;

// FMD γ. False-positive rate = 2^-γ. Must match asset registry + circuit.
export const FMD_GAMMA = 5;
