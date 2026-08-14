import type { InputSlot } from "@lelantos-org/sdk/bundle";
import type { AuxOutput, DepositRequest } from "@lelantos-org/sdk/protocol";

// Flip one bit so `verifyProof`'s pairing fails. A deposit occupies one leaf,
// so `outCm` is a single commitment rather than the old pair.
export function mutateOutCm(request: DepositRequest): DepositRequest {
    const cm = request.outCm;
    const bytes = cm.startsWith("0x") ? cm.slice(2) : cm;
    const head = bytes.slice(0, -2);
    const tail = parseInt(bytes.slice(-2), 16) ^ 0x01;
    return { ...request, outCm: "0x" + head + tail.toString(16).padStart(2, "0") };
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
