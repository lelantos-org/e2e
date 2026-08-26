// Addresses fixed outside this repo, rather than assigned by the deploy.

/**
 * Permit2's deterministic deployment address, identical on every chain.
 *
 * Refresh the accompanying bytecode by extracting it from a forge run:
 *   forge script script/DeployTest.s.sol:DeployTest --rpc-url <anvil> \
 *     --private-key 0x... --broadcast -vvvv \
 *     | grep -oE "VM::etch\(0x000...022D473030F116dDEE9F6B43aC78BA3, 0x[0-9a-f]+\)"
 */
export const CANONICAL_PERMIT2_ADDRESS =
    "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Burn / non-allowlisted adapter sentinel for negative tests.
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;
