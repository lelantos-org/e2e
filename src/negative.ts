import type { AuxOutput, DepositIntent, InputSlot } from "@lelantos-org/sdk";

// Flip one bit so `verifyProof`'s pairing fails.
export function mutateOutCm(intent: DepositIntent): DepositIntent {
    const [c0, c1] = intent.outCm;
    const bytes = c0.startsWith("0x") ? c0.slice(2) : c0;
    const head = bytes.slice(0, -2);
    const tail = parseInt(bytes.slice(-2), 16) ^ 0x01;
    return { ...intent, outCm: ["0x" + head + tail.toString(16).padStart(2, "0"), c1] };
}

// Zero-sibling path yields a root absent from MASP's known-root set.
export function mutateMerklePath(slot: InputSlot): InputSlot {
    return {
        ...slot,
        pathElements: slot.pathElements.map((level) => level.map(() => 0n)),
    };
}

export function expiredPermitDeadline(): bigint {
    return BigInt(Math.floor(Date.now() / 1000) - 60);
}

// Mismatched ephemeral pubkey breaks ECDH; recipient cannot decrypt.
export function mutateAux(aux: AuxOutput): AuxOutput {
    return { ...aux, ephPubX: aux.ephPubX ^ 1n };
}
