// Reading typed events off a receipt.
//
// Lives outside `harness.ts` so the testkit can use it: `harness` re-exports
// the testkit, and a testkit module importing back from `harness` closes an
// ESM import cycle that typechecks and then bites at runtime.

import { ethers } from "ethers";

// Skips logs from foreign ABIs (ethers parseLog throws on those).
export function parseContractLogs(
    receipt: ethers.TransactionReceipt | ethers.ContractTransactionReceipt | null,
    contract: ethers.Contract,
    eventName: string,
): ethers.LogDescription[] {
    if (!receipt) return [];
    const out: ethers.LogDescription[] = [];
    for (const log of receipt.logs) {
        try {
            const parsed = contract.interface.parseLog(log);
            if (parsed?.name === eventName) out.push(parsed);
        } catch {
            // wrong contract
        }
    }
    return out;
}
