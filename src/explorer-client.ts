export interface TreeAdvance {
    startIndex: number;
    inserted: number;
    newRootHex: string;
}

export interface IntentRecord {
    id: string;
    cm0: string;
    cm1: string;
    txHash: string;
}

export class ExplorerClient {
    constructor(private readonly baseUrl: string, private readonly chainId: bigint) {}

    private url(path: string, params: Record<string, string | number> = {}): string {
        const qs = new URLSearchParams({ chainId: this.chainId.toString(), ...Object.fromEntries(
            Object.entries(params).map(([k, v]) => [k, String(v)]),
        ) });
        return `${this.baseUrl}${path}?${qs}`;
    }

    async treeAdvances(opts: { limit?: number } = {}): Promise<TreeAdvance[]> {
        const r = await fetch(this.url("/v1/tree-advances", { limit: opts.limit ?? 20 }));
        if (!r.ok) throw new Error(`explorer.treeAdvances: ${r.status}`);
        return (await r.json()) as TreeAdvance[];
    }

    async intentById(id: string): Promise<IntentRecord | null> {
        const r = await fetch(this.url(`/v1/intents/${id}`));
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`explorer.intentById: ${r.status}`);
        return (await r.json()) as IntentRecord;
    }

    async healthz(): Promise<boolean> {
        const r = await fetch(`${this.baseUrl}/health`).catch(() => null);
        return r?.ok ?? false;
    }
}
