// Test-runtime environment. All values come from the compose-injected
// container env (see e2e/compose.backend.yml `services.runner`).

function req(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing env var: ${name}`);
    return v;
}

export const env = {
    relayerUrl: req("RELAYER_URL"),
    fmdUrl: req("FMD_URL"),
    explorerUrl: req("EXPLORER_URL"),
    rpcUrl: req("RPC_URL"),
    maspAddress: req("MASP_ADDRESS"),
    token1: req("TOKEN_1"),
    chainId: BigInt(req("CHAIN_ID")),
    payerAddress: req("PAYER_ADDRESS"),
    payerKey: req("PAYER_KEY"),
    recipientAddress: req("RECIPIENT_ADDRESS"),
    circuitsBuild: process.env.CIRCUITS_BUILD ?? "/app/circuits-build",
};
