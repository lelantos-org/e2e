// Refresh bytecode by extracting from a forge run:
//   forge script script/DeployTest.s.sol:DeployTest --rpc-url <anvil> \
//     --private-key 0x... --broadcast -vvvv \
//     | grep -oE "VM::etch\(0x000...022D473030F116dDEE9F6B43aC78BA3, 0x[0-9a-f]+\)"
export const CANONICAL_PERMIT2_ADDRESS =
    "0x000000000022D473030F116dDEE9F6B43aC78BA3";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function permit2Bytecode(): string {
    if (cached) return cached;
    // ESM: no `__dirname`. The hex sits next to this source file.
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
