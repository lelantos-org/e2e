import { defineConfig } from "vitest/config";

import PathSequencer from "./src/sequencer.js";
import { TEST_TIMEOUT } from "./src/testkit/timeouts.js";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        // Ceiling for an `it` that names no budget: the longest narrative the
        // suite runs. Tests pass the named budget for what they wait on; see
        // `src/testkit/timeouts.ts`.
        testTimeout: TEST_TIMEOUT.SEQUENCE,
        // Per-file `beforeAll`: funding, minting, wallet construction, after
        // `setupHarness` has waited up to 120s for fmd and 30s for the payer's
        // nonce to settle. Stack bring-up is not covered by it: `globalSetup`
        // runs outside the hook timeout and boots the containers plus the
        // forge deploy.
        hookTimeout: 240_000,
        // Sequential: the stack has shared on-chain state.
        fileParallelism: false,
        // One worker process for the whole run rather than a fork per file.
        // Poseidon, Jubjub and snarkjs are memoised per process (harness.ts),
        // so isolating files would repeat that setup for each one.
        pool: "forks",
        poolOptions: { forks: { singleFork: true } },
        sequence: { shuffle: false, sequencer: PathSequencer },
        globalSetup: ["./src/setup.ts"],
        // Per-file teardown: release the wallets that file built. Runs inside
        // the fork, unlike `globalSetup`.
        setupFiles: ["./src/test-setup.ts"],
        reporters: process.env.CI
            ? ["verbose", ["junit", { outputFile: "./test-results.xml" }]]
            : ["verbose"],
    },
});
