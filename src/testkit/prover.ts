// Paths to the 4x4 proving artifacts.
//
// Resolved through `createRequire` rather than a relative path so the files are
// found inside `@lelantos-org/circuits` wherever npm installed it: a hoisted
// root `node_modules`, a nested one, or a workspace link.
//
// Its own module because both `harness.ts` and `wallet.ts` need it, and
// `harness.ts` already imports `wallet.ts` for the barrel.

import { createRequire } from "node:module";

const resolve = createRequire(import.meta.url).resolve;

export const PROVER_PATHS = {
    wasmPath: resolve("@lelantos-org/circuits/4x4/4x4.wasm"),
    zkeyPath: resolve("@lelantos-org/circuits/4x4/4x4_final.zkey"),
};
