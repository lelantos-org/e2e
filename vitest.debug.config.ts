import base from "./vitest.config.js";

const cfg: any = base;
cfg.test.setupFiles = ["./debug-http.setup.ts", "./src/test-setup.ts"];
export default cfg;
