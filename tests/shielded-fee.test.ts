// The relayer's fee identity is committed, so nothing derives it at boot and
// nothing would notice if the constants and the nsk drifted apart.
//
// They can drift in two ways, and both are silent until the whole stack is
// running: an address that no longer matches the key makes the relayer refuse
// to boot (`FeeRecipient::new` checks exactly this), and a key that no longer
// matches the address makes it boot and then decline to flush every deposit
// with "fee note is not addressed to this relayer".
//
// Re-deriving both from the nsk here turns either into a unit-test failure.

import { describe, expect, it } from "vitest";

import { Jubjub, Poseidon } from "@lelantos-org/sdk/crypto";
import { buildSpendingKey, encodeAddress } from "@lelantos-org/sdk/keys";

import {
    RELAYER_FEE_ADDRESS,
    RELAYER_FEE_IVK,
    RELAYER_FEE_NSK,
} from "../src/protocol/shielded-fee.js";

describe("relayer shielded fee identity", () => {
    it("the committed address and viewing key are the ones the nsk derives", async () => {
        const [P, J] = await Promise.all([Poseidon.build(), Jubjub.build()]);
        const keys = buildSpendingKey(P, J, RELAYER_FEE_NSK);

        expect(encodeAddress(J, keys.pk_d, keys.pk, keys.ck)).toBe(RELAYER_FEE_ADDRESS);
        expect(`0x${keys.ivk.toString(16).padStart(64, "0")}`).toBe(RELAYER_FEE_IVK);
    });
});
