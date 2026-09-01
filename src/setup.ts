import { execSync } from "node:child_process";

resolveDockerHost();
enableRyuk();

import type { StackEnv } from "./stack.js";
import { log } from "./utils.js";

export default async function setup() {
    // Dynamic import: the env tweaks above must land before testcontainers
    // loads.
    const { Stack } = await import("./stack.js");
    const stack = new Stack();

    process.on("SIGINT", () => {
        stack.down().finally(() => process.exit(130));
    });

    log("starting postgres + anvil…");
    const { rpc } = await stack.up();
    log("anvil ready at", rpc);

    log("deploying contracts…");
    const addrs = await stack.deploy();
    log("MASP =", addrs.masp);
    log("tokens =", addrs.tokens);
    log("swap =", addrs.swap);
    log("yield =", addrs.yield);

    log("starting backend services…");
    const urls = await stack.upBackend(addrs);
    log("urls =", urls);

    publishEnv(stack.env(urls));

    return async () => {
        if (keepAlive()) {
            log("E2E_KEEP_ALIVE=1: leaving the stack running (reaper off; `just down` to clean up)");
            return;
        }
        log("tearing down stack…");
        await stack.down();
    };
}

// testcontainers reads DOCKER_HOST at module-load time.
function resolveDockerHost(): void {
    if (process.env.DOCKER_HOST) return;
    try {
        const ctx = execSync(
            "docker context inspect $(docker context show) --format '{{ .Endpoints.docker.Host }}'",
            { shell: "/bin/bash", encoding: "utf8" },
        ).trim();
        if (ctx) process.env.DOCKER_HOST = ctx;
    } catch {
        // testcontainers will fall back to its own discovery
    }
}

/**
 * Let Ryuk reap the stack when this process dies before its teardown runs.
 *
 * Ryuk is itself a container: it watches the docker socket and removes
 * everything carrying this session's id once the client disconnects. It
 * therefore needs that socket bind-mounted, and testcontainers mounts whatever
 * path `DOCKER_HOST` names. On colima that is a host path
 * (`~/.colima/default/docker.sock`) which does not exist inside the VM where
 * Ryuk runs: the mount resolves to nothing, Ryuk never logs "Started", and its
 * startup wait times out. Naming the in-VM path avoids that.
 *
 * Only a unix socket needs the override. A TCP `DOCKER_HOST` (remote docker,
 * some CI setups) has no socket to mount and Ryuk reaches the daemon over the
 * network.
 *
 * `E2E_KEEP_ALIVE=1` disables the reaper, since it means "leave the stack up
 * to read its logs" and Ryuk would remove it as soon as the run ends.
 * `TESTCONTAINERS_RYUK_DISABLED=true` disables the reaper without keeping the
 * stack. Either way, `just down` is the manual cleanup.
 */
function enableRyuk(): void {
    if (keepAlive()) {
        process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
        return;
    }
    if (process.env.DOCKER_HOST?.startsWith("unix://")) {
        process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= "/var/run/docker.sock";
    }
}

/**
 * Leave the stack running after the suite finishes, for `docker logs` and
 * `curl` against the mapped ports. Skips teardown and the reaper.
 */
function keepAlive(): boolean {
    return process.env.E2E_KEEP_ALIVE === "1";
}

function publishEnv(e: StackEnv): void {
    process.env.RELAYER_URL = e.relayer;
    process.env.FMD_URL = e.fmd;
    process.env.RPC_URL = e.rpc;
    process.env.CHAIN_ID = e.chainId;
    process.env.MASP_ADDRESS = e.masp;
    for (const [id, addr] of Object.entries(e.tokens)) {
        process.env[`TOKEN_${id}`] = addr;
    }
    process.env.PAYER_ADDRESS = e.payerAddress;
    process.env.PAYER_KEY = e.payerKey;
    process.env.RECIPIENT_ADDRESS = e.recipientAddress;
    process.env.PERMIT2_ADDRESS = e.permit2;
    if (e.nativeAdapter) process.env.NATIVE_ADAPTER_ADDRESS = e.nativeAdapter;
    if (e.metaquoter) process.env.METAQUOTER_URL = e.metaquoter;
    if (e.swap) {
        process.env.UNIV3_QUOTER_ADDRESS = e.swap.univ3Quoter;
        process.env.UNIV3_ADAPTER_ADDRESS = e.swap.univ3Adapter;
    process.env.UNIV4_QUOTER_ADDRESS = e.swap.univ4Quoter;
    process.env.UNIV4_ADAPTER_ADDRESS = e.swap.univ4Adapter;
        process.env.MOCK_SWAP_ROUTER_ADDRESS = e.swap.mockSwapRouter;
        process.env.SWAP_WRAPPER_ADDRESS = e.swap.wrapper;
    }
    if (e.yield) {
        // The id list is published alongside the addresses because the ids
        // themselves are a deploy output — they come from the fixture and
        // YIELD_ID_OFFSET, and a test that scanned process.env for the keys
        // instead would silently see none when the deploy was skipped.
        process.env.YIELD_ASSET_IDS = Object.keys(e.yield).join(",");
        for (const [id, a] of Object.entries(e.yield)) {
            process.env[`YIELD_TOKEN_${id}`] = a.token;
            process.env[`YIELD_VAULT_${id}`] = a.vault;
            process.env[`YIELD_VENUE_${id}`] = a.venue;
        }
    }
}
