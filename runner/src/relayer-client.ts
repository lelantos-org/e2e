// Minimal HTTP client for the relayer. Mirrors the wire format the
// relayer's dto/transact.rs expects.

export interface SubmitTransactPayload {
    chain_id: number;
    proof2x2: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    pub_inputs: PubInputsDto;
    aux: [OutputAuxDto, OutputAuxDto];
}

export interface PubInputsDto {
    merkle_root: string;
    nullifier: [string, string];
    out_cm: [string, string];
    public_asset_id: number;
    pub_asset_gen: { x: string; y: string };
    public_in: number;
    public_out: number;
    in_cv: [{ x: string; y: string }, { x: string; y: string }];
    out_cv: [{ x: string; y: string }, { x: string; y: string }];
    recipient: string;
    chain_id: number;
    payer: string;
    relayer: string;
}

export interface OutputAuxDto {
    clue_r: { x: string; y: string };
    eph_pub: { x: string; y: string };
    /// 0x-hex of the 2-byte clueBits prefix || ChaCha20-Poly1305 body.
    ciphertext: string;
}

export interface RelayerSubmitResponse {
    tx_hash: string;
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
