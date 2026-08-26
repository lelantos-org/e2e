// Per-file teardown, wired in through `setupFiles` (see `vitest.config.ts`).
//
// `setupFiles` is evaluated once per test file, so the `afterAll` registered
// here is scoped to that file's suites and runs after its last `it`.

import { afterAll } from "vitest";

import { disposeTestWallets } from "./wallet.js";

// The suite runs in a single fork: without this, a wallet built in one file
// holds its scanner and prover for every file that follows.
afterAll(disposeTestWallets);
