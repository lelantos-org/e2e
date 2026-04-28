import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        // Allow up to 5 minutes per test — proof generation + chain inclusion +
        // indexer pickup can take a while in CI.
        testTimeout: 300_000,
        hookTimeout: 60_000,
        // Single-file sequential — the e2e stack has shared on-chain state.
        fileParallelism: false,
    },
});
