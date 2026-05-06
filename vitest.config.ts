import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        // Allow up to 5 minutes per test — proof generation + chain inclusion +
        // indexer pickup can take a while in CI.
        testTimeout: 300_000,
        // Bring-up of 8 containers + forge deploy. Warm-cache run ≈ 30 s;
        // 90 s gives generous slack for cold image pull on CI.
        hookTimeout: 90_000,
        // Single-file sequential — the e2e stack has shared on-chain state.
        fileParallelism: false,
        globalSetup: ["./src/setup.ts"],
    },
});
