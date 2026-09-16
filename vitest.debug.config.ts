import { defineConfig } from "vitest/config";

import base from "./vitest.config.js";

// The suite's config with the debug shim loaded ahead of the per-file teardown.
// Built as a copy: `base` is the object `vitest.config.ts` exports.
export default defineConfig({
    ...base,
    test: {
        ...base.test,
        setupFiles: ["./debug-http.setup.ts", "./src/test-setup.ts"],
    },
});
