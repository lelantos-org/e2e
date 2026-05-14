import { Command } from "commander";

import { Stack } from "./stack.js";
import { waitForSignal } from "./utils.js";

const program = new Command();

program
    .name("e2e")
    .description("Lifecycle CLI for the local e2e stack")
    .version("0.0.0");

program
    .command("up")
    .description("Boot the full stack (postgres + anvil + 6 backends + deploy) and keep it alive until ctrl-c")
    .action(async () => {
        const stack = new Stack();
        installSigintHandler(stack);

        await stack.up();
        const addrs = await stack.deploy();
        const urls = await stack.upBackend(addrs);
        console.log(JSON.stringify({ urls, addrs }, null, 2));
        console.log("\nstack running. ctrl-c to tear down.");
        await waitForSignal();
        await stack.down();
    });

program
    .command("deploy")
    .description("Boot postgres + anvil, run the contract deploy, print addresses, then tear down")
    .action(async () => {
        const stack = new Stack();
        installSigintHandler(stack);

        await stack.up();
        const addrs = await stack.deploy();
        console.log(JSON.stringify(addrs, null, 2));
        await stack.down();
    });

program
    .command("down")
    .description("Best-effort cleanup of orphan testcontainers (use after kill -9 etc.)")
    .action(() => {
        console.log("Containers + networks created by testcontainers are auto-cleaned");
        console.log("on process exit. For stuck state run:");
        console.log("  docker container prune -f && docker network prune -f");
    });

program
    .command("urls")
    .description("Show how to print stack URLs (only meaningful while a Stack is alive)")
    .action(() => {
        console.log("Stack URLs are emitted by `npm run up` to stdout.");
        console.log("For a one-shot dump, run `npm run up` in one shell.");
    });

program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
});

function installSigintHandler(stack: Stack): void {
    process.on("SIGINT", () => {
        stack.down().finally(() => process.exit(130));
    });
}
