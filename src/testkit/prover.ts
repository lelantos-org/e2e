// Where the 4x4 proving artifacts live.
//
// Resolved through `createRequire` rather than a relative path so the files are
// found inside `@lelantos-org/circuits` wherever npm actually installed it —
// a hoisted root `node_modules`, a nested one, or a workspace link.
//
// This sits in its own module because both `harness.ts` and `wallet.ts` need
// it: with it defined in `harness.ts`, `wallet.ts` had to import back from
// `harness.ts`, which already imports `wallet.ts` for the barrel. That cycle
// only stayed benign because the value is read inside a function body rather
// than at module init.

import { createRequire } from "node:module";

const resolve = createRequire(import.meta.url).resolve;

export const PROVER_PATHS = {
    wasmPath: resolve("@lelantos-org/circuits/4x4/4x4.wasm"),
    zkeyPath: resolve("@lelantos-org/circuits/4x4/4x4_final.zkey"),
};
