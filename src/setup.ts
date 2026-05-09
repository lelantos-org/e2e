// Vitest globalSetup: bring the stack up before any test loads, tear it
// down after. URLs + addresses are forwarded to tests through
// `process.env`; `src/env.ts` consumes them.

import { execSync } from "node:child_process";

resolveDockerHost();
disableRyuk();

import type { StackEnv } from "./stack";
import { log } from "./utils";

export default async function setup() {
    // Dynamic import: dockerHost / Ryuk env tweaks above must land before
    // testcontainers loads.
    const { Stack } = await import("./stack");
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

    log("starting backend services…");
    const urls = await stack.upBackend(addrs);
    log("urls =", urls);

    publishEnv(stack.env(urls));

    return async () => {
        if (process.env.E2E_KEEP_ALIVE === "1") {
            log("E2E_KEEP_ALIVE=1 → leaving stack running");
            return;
        }
        log("tearing down stack…");
        await stack.down();
    };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/// Resolve the docker socket from the active docker context (colima,
/// Docker Desktop, etc.) before testcontainers loads — it inspects
/// DOCKER_HOST at module-load time.
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

/// Ryuk (the testcontainers reaper) needs to run privileged and pulls a
/// separate image; on colima it fails the default "Started" log wait.
/// Vitest's globalTeardown handles cleanup deterministically anyway.
function disableRyuk(): void {
    process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
}

function publishEnv(e: StackEnv): void {
    process.env.RELAYER_URL = e.relayer;
    process.env.FMD_URL = e.fmd;
    process.env.EXPLORER_URL = e.explorer;
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
}
