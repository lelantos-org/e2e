// SDK 0.5 swapped its signer abstraction from `ethers.Signer` to the
// viem-shaped `EthSigner`. e2e still drives Foundry/ABI work through
// ethers, so tests carry two views of the PAYER:
//   * `h.payer`   — `ethers.Wallet` for direct contract calls
//   * `payerEthSigner()` — viem `EthSigner` for SDK paths (permit2 sign,
//     submitIntent, transact, swap)
// Both must NOT cache nonces locally, otherwise they diverge from chain
// state (see harness.ts comment on dropping `NonceManager`).

import { type EthSigner, PrivateKeySigner } from "@lelantos-org/sdk";
import type { Hex } from "viem";

import { env } from "./env.js";

let _payer: EthSigner | undefined;

/// Lazy `EthSigner` over `env.payerKey`. Reused per-process so the SDK
/// adapter and direct-submit helpers all touch the same instance.
export function payerEthSigner(): EthSigner {
    _payer ??= new PrivateKeySigner(env.payerKey as Hex, env.rpcUrl, env.chainId);
    return _payer;
}
