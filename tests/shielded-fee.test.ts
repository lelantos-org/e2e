// The relayer's fee identity is committed rather than derived at boot, so
// nothing would otherwise notice the constants drifting from the nsk.
//
// Both drift modes are silent until the whole stack runs: an address that no
// longer matches the key makes the relayer refuse to boot (`FeeRecipient::new`
// checks this), and a key that no longer matches the address makes it boot and
// then decline to flush every deposit with "fee note is not addressed to this
// relayer". Re-deriving both here turns either into a unit-test failure.

import { describe, expect, it } from "vitest";

import { addressFromViewingKey, buildSpendingKey, Jubjub, Poseidon } from "@lelantos-org/sdk/primitives";

import {
    RELAYER_FEE_ADDRESS,
    RELAYER_FEE_IVK,
    RELAYER_FEE_NSK,
} from "../src/protocol/shielded-fee.js";

describe("relayer shielded fee identity", () => {
    it("the committed address and viewing key are the ones the nsk derives", async () => {
        const [P, J] = await Promise.all([Poseidon.build(), Jubjub.build()]);
        const keys = buildSpendingKey(P, RELAYER_FEE_NSK);

        expect(addressFromViewingKey(P, J, keys)).toBe(RELAYER_FEE_ADDRESS);
        expect(`0x${keys.ivk.toString(16).padStart(64, "0")}`).toBe(RELAYER_FEE_IVK);
    });
});
