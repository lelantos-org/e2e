import { defineConfig } from "vitest/config";

import PathSequencer from "./src/sequencer.js";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        // Ceiling of 5 minutes per test: proof generation, chain inclusion and
        // indexer pickup are slow in CI. Individual tests narrow this with the
        // named budgets in `src/testkit/timeouts.ts`.
        testTimeout: 300_000,
        // Per-file `beforeAll`: funding, minting, wallet construction. Stack
        // bring-up is not covered by it: `globalSetup` runs outside the hook
        // timeout and boots the containers plus the forge deploy.
        hookTimeout: 90_000,
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
