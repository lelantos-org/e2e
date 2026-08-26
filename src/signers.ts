// The SDK's signer abstraction is the viem-shaped `EthSigner`, while e2e drives
// Foundry/ABI work through ethers. Tests therefore carry two views of the
// PAYER account:
//   * `h.payer`          — `ethers.Wallet` for direct contract calls
//   * `payerEthSigner()` — viem `EthSigner` for SDK paths (permit2 sign,
//                          deposit, transact, swap)
// Neither may cache nonces locally: both send from the same account, so a
// local counter diverges from chain state. See `tx.ts`.

import { type EthSigner, PrivateKeySigner } from "@lelantos-org/sdk";
import type { Hex } from "viem";

import { env } from "./env.js";

let _payer: EthSigner | undefined;

/**
 * Lazy `EthSigner` over `env.payerKey`. Memoised per process so the SDK
 * adapter and the direct-submit helpers share one instance.
 */
export function payerEthSigner(): EthSigner {
    _payer ??= new PrivateKeySigner(env.payerKey as Hex, env.rpcUrl, env.chainId);
    return _payer;
}
