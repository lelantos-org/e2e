// Minimal HTTP client for the relayer. Mirrors the wire format the
// relayer's dto/transact.rs expects (camelCase).

export interface SubmitTransactPayload {
    chainId: number;
    proof2x2: { piA: string[]; piB: string[][]; piC: string[] };
    pubInputs: PubInputsDto;
    aux: [OutputAuxDto, OutputAuxDto];
}

export interface PubInputsDto {
    merkleRoot: string;
    nullifier: [string, string];
    outCm: [string, string];
    publicAssetId: number;
    pubAssetGen: { x: string; y: string };
    publicIn: number;
    publicOut: number;
    inCv: [{ x: string; y: string }, { x: string; y: string }];
    outCv: [{ x: string; y: string }, { x: string; y: string }];
    recipient: string;
    chainId: number;
    payer: string;
    relayer: string;
}

export interface OutputAuxDto {
    clueR: { x: string; y: string };
    ephPub: { x: string; y: string };
    /// 0x-hex of the 2-byte clueBits prefix || ChaCha20-Poly1305 body.
    ciphertext: string;
}

export interface RelayerSubmitResponse {
    txHash: string;
}

export class RelayerClient {
    constructor(public readonly baseUrl: string) {}

    async health(): Promise<unknown> {
        const r = await fetch(this.baseUrl + "/health");
        if (!r.ok) throw new Error(`health failed: ${r.status}`);
        return r.json();
    }

    async submitTransact(p: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        const r = await fetch(this.baseUrl + "/v1/transact", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(p),
        });
        if (!r.ok) {
            const body = await r.text();
            throw new Error(`relayer ${r.status}: ${body}`);
        }
        return (await r.json()) as RelayerSubmitResponse;
    }
}
