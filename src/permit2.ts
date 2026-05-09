// Permit2 canonical address + bytecode. Used to pre-deploy via
// anvil_setCode RPC, since DeployTest.s.sol's `DeployPermit2` lib only
// uses `vm.etch` (cheatcode) which is dropped under `--broadcast`.
//
// Address: deterministic CREATE2 deployment from
// https://github.com/Uniswap/permit2 (mainnet + every L2). Bytecode
// extracted from `vm.etch` trace of `DeployPermit2.deployPermit2()`
// against forge 1.5.1-stable. Refresh by re-running:
//   forge script script/DeployTest.s.sol:DeployTest --rpc-url <anvil> \
//     --private-key 0x... --broadcast -vvvv \
//     | grep -oE "VM::etch\(0x000...022D473030F116dDEE9F6B43aC78BA3, 0x[0-9a-f]+\)"

export const CANONICAL_PERMIT2_ADDRESS =
    "0x000000000022D473030F116dDEE9F6B43aC78BA3";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let cached: string | undefined;

export function permit2Bytecode(): string {
    if (cached) return cached;
    cached = readFileSync(resolve(__dirname, "permit2.bytecode.hex"), "utf8").trim();
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
