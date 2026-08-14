import { defineConfig } from "vitest/config";

import PathSequencer from "./src/sequencer.js";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        // Allow up to 5 minutes per test — proof generation + chain inclusion +
        // indexer pickup can take a while in CI. Individual tests narrow this
        // with the named budgets in `TIMEOUT` (src/constants.ts).
        testTimeout: 300_000,
        // Per-file `beforeAll`: funding, minting, wallet construction. Stack
        // bring-up is *not* covered by this — `globalSetup` runs outside the
        // hook timeout and boots the 8 containers plus the forge deploy.
        hookTimeout: 90_000,
        // Single-file sequential — the e2e stack has shared on-chain state.
        fileParallelism: false,
        // One worker process for the whole run instead of a fresh fork per
        // file. Poseidon/Jubjub/snarkjs are memoised per process (harness.ts),
        // so isolation meant paying for that setup 12 times over.
        pool: "forks",
        poolOptions: { forks: { singleFork: true } },
        sequence: { shuffle: false, sequencer: PathSequencer },
        globalSetup: ["./src/setup.ts"],
        reporters: process.env.CI
            ? ["verbose", ["junit", { outputFile: "./test-results.xml" }]]
            : ["verbose"],
    },
});
