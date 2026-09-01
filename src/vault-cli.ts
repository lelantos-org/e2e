// Yield-vault controls for a stack that is already running, for driving the
// index by hand outside vitest. Lifecycle (`up`, `deploy`) is
// `src/orchestrate.ts`; this attaches to what that left behind.
//
// The mock vault only accrues when something calls `earn`, and nothing in the
// stack does. So a freshly deployed yield asset sits at exactly `RAY` forever,
// and every reader of it — the explorer's `return` column, `wallet.asset()` —
// truthfully reports +0%. This is the switch that makes it move.

import { Command } from "commander";
import { ethers } from "ethers";

import { evmAddress } from "@lelantos-org/sdk";

import { DEPLOYER } from "./accounts.js";
import type { YieldAssetEnv } from "./env.js";
import {
    MASP_YIELD_ABI,
    MOCK_ERC20_ABI,
    MOCK_ERC4626_ABI,
    YIELD_VENUE_ABI,
} from "./protocol/abi.js";

/** RAY, the scale the pool reports its index in. */
const RAY = 10n ** 27n;

interface Conn {
    signer: ethers.Wallet;
    masp: ethers.Contract;
}

/**
 * Attach to a running stack.
 *
 * Both coordinates are required rather than defaulted: the stack's ports are
 * assigned by testcontainers and its addresses by a fresh deploy, so anything
 * hard-coded here would be right only by coincidence. `just up` prints both.
 *
 * Signs as the deployer, which is who `DeployTestYield` ran as. The mock
 * ERC-20s have an open `mint`, so that account can also fund the credit.
 */
function connect(opts: { rpc?: string; masp?: string }): Conn {
    const rpc = opts.rpc ?? process.env.RPC_URL;
    const masp = opts.masp ?? process.env.MASP_ADDRESS;
    if (!rpc) throw new Error("no RPC: pass --rpc or set RPC_URL (see `just up` output)");
    if (!masp) throw new Error("no MASP: pass --masp or set MASP_ADDRESS (see `just up` output)");

    const provider = new ethers.JsonRpcProvider(rpc);
    return {
        signer: new ethers.Wallet(DEPLOYER.privateKey, provider),
        masp: new ethers.Contract(masp, MASP_YIELD_ABI, provider),
    };
}

/**
 * The asset triple behind an id, resolved from the chain rather than from env.
 *
 * `src/env.ts` reads the `YIELD_*` variables `setup.ts` publishes, which exist
 * only inside a vitest run. A standalone command has none of them, so it walks
 * the deploy in reverse instead: the pool names the venue, and the venue's
 * immutables name the vault and the token.
 */
async function resolve(conn: Conn, id: bigint): Promise<YieldAssetEnv> {
    const state = await conn.masp.yieldState(id);
    if (state.venue === ethers.ZeroAddress) {
        throw new Error(`asset ${id} is not a yield asset (no venue bound)`);
    }
    const venue = new ethers.Contract(state.venue, YIELD_VENUE_ABI, conn.signer.provider);
    const [vault, token] = await Promise.all([venue.VAULT(), venue.UNDERLYING()]);
    return {
        id,
        token: evmAddress(token),
        vault: evmAddress(vault),
        venue: evmAddress(state.venue),
    };
}

/**
 * `amount`, given in whole tokens, as base units — plus enough balance and
 * allowance for the vault to pull it.
 *
 * The mock pulls the credit from the caller, which is what makes the gain real
 * rather than a bookkeeping entry the pool's own accounting would disagree
 * with. An unfunded signer fails inside `earn` with an ERC-20 error that says
 * nothing about yield, so the shortfall is minted here; these are mocks with an
 * open `mint`, which is the only reason that is allowed to be this casual.
 */
async function fund(conn: Conn, asset: YieldAssetEnv, amount: string): Promise<bigint> {
    const token = new ethers.Contract(asset.token, MOCK_ERC20_ABI, conn.signer);
    const amt = ethers.parseUnits(amount, await token.decimals());

    const held: bigint = await token.balanceOf(conn.signer.address);
    if (held < amt) await (await token.mint(conn.signer.address, amt - held)).wait();
    await (await token.approve(asset.vault, amt)).wait();
    return amt;
}

/** The index as a percentage above RAY, which is how every UI shows it. */
function growth(index: bigint): string {
    return `${(Number(index) / Number(RAY) - 1) * 100}%`;
}

const program = new Command();

program.name("vault").description("Yield-vault controls for a running stack").version("0.0.0");

program
    .command("earn")
    .description("Credit a mock vault with interest, moving the asset's index above RAY")
    .argument("<id>", "yield asset id")
    .argument("<amount>", "interest to credit, in whole tokens, e.g. 0.5")
    .option("--rpc <url>", "node URL (default: $RPC_URL)")
    .option("--masp <address>", "pool address (default: $MASP_ADDRESS)")
    .action(async (id: string, amount: string, opts: { rpc?: string; masp?: string }) => {
        const conn = connect(opts);
        const assetId = BigInt(id);
        const asset = await resolve(conn, assetId);

        const symbol = await new ethers.Contract(
            asset.token,
            MOCK_ERC20_ABI,
            conn.signer.provider,
        ).symbol();
        const before: bigint = await conn.masp.index(assetId);

        // `yield-harness.ts` has this call already, but importing it evaluates
        // `env.ts`, which requires the `RELAYER_URL`/`FMD_URL` set that only a
        // vitest run publishes — and this command deliberately needs neither.
        const vault = new ethers.Contract(asset.vault, MOCK_ERC4626_ABI, conn.signer);
        await (await vault.earn(await fund(conn, asset, amount))).wait();

        // Read back rather than predicted: `index` is `gross / supply`, so what
        // a credit is worth depends on a supply this command never saw. On an
        // asset nothing has been shielded into, supply is zero and the pool
        // returns RAY however much the vault holds — which is worth seeing
        // rather than assuming.
        const after: bigint = await conn.masp.index(assetId);
        console.log(`credited ${amount} ${symbol} to vault ${asset.vault}`);
        console.log(`index ${before} -> ${after}  (${growth(before)} -> ${growth(after)})`);
    });

program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
});
