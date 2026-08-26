// Permit2 pre-deploy.
//
// `DeployTest.s.sol` places Permit2 with `vm.etch`, which is dropped under
// `--broadcast`, so the bytecode is written directly with `anvil_setCode`
// before the deploy runs. The address is re-exported here so callers get it
// from the module that also deploys the code at it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_PERMIT2_ADDRESS } from "./chain/well-known.js";

export { CANONICAL_PERMIT2_ADDRESS };

let cached: string | undefined;

function permit2Bytecode(): string {
    if (cached) return cached;
    // ESM has no `__dirname`; the hex sits next to this source file.
    const here = dirname(fileURLToPath(import.meta.url));
    cached = readFileSync(resolve(here, "permit2.bytecode.hex"), "utf8").trim();
    return cached;
}

export async function preDeployPermit2(rpcUrl: string): Promise<void> {
    const code = permit2Bytecode();
    const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "anvil_setCode",
            params: [CANONICAL_PERMIT2_ADDRESS, code],
        }),
    });
    if (!res.ok) throw new Error(`anvil_setCode HTTP ${res.status}`);
    const j = (await res.json()) as { error?: { message: string } };
    if (j.error) throw new Error(`anvil_setCode: ${j.error.message}`);
}
