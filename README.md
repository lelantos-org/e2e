# e2e — host-driven full-stack tests

Boots the full Lelantos stack (postgres + anvil + the six backend
services) via [testcontainers-node][tc] and exercises deposit → shielded
transfer → withdraw → fmd-driven sync end-to-end. Container lifecycle is
owned by the test process, not docker compose; failures surface
host-side stack traces and `console.log` works without rebuilding any
image.

[tc]: https://node.testcontainers.org/

## Topology

```
host process (vitest globalSetup)
  ├─ stack.up()            postgres + anvil (testcontainers)
  ├─ stack.deploy()        forge script Deploy.s.sol → addresses
  ├─ stack.upBackend()     ingester, fmd-indexer, explorer-indexer,
  │                         fmd-webserver, explorer-webserver, relayer
  └─ vitest tests run on host, talking to mapped ports
                              (anvil :ephemeral, fmd, explorer, relayer)
```

## Prereqs

- Docker (Docker Desktop or colima).
- `forge` + `anvil` from the foundry toolchain (host).
- Backend service images built locally:
  ```bash
  cd backend && for c in ingester fmd-indexer fmd-webserver explorer-indexer explorer-webserver; do
      docker build --build-arg PACKAGE=$c -t lelantos/$c:dev -f Dockerfile .
  done
  docker build -f backend/crates/relayer/Dockerfile -t lelantos/relayer:dev .
  ```
- Circuit artifacts at `circuits/build/2x2_final.zkey` + `circuits/build/2x2_js/2x2.wasm` —
  produced by `cd circuits && just rebuild`.

## Commands

```bash
just test       # vitest globalSetup → stack up → forge deploy → 4 tests → tear down
just up         # bring stack up + keep alive (ctrl-c to drop). prints urls.
just deploy     # bring up postgres+anvil, deploy contracts, print addresses, tear down
just down       # best-effort docker prune for orphan containers/networks
```

`E2E_KEEP_ALIVE=1 just test` leaves the stack running on test exit so
you can `curl` the indexers / mapped ports for manual inspection.

## Layout

| Path | Purpose |
|---|---|
| [config/](config/) | TOML configs mounted into backend containers (`ingester.toml`, `relayer.toml`, `explorer-indexer.toml`). |
| [src/](src/) | TS test driver + stack lifecycle. Single npm package. |
| [src/stack.ts](src/stack.ts) | `Stack` class — three-phase lifecycle (up / deploy / upBackend / down). |
| [src/services.ts](src/services.ts) | Declarative `ServiceSpec` table for every container. |
| [src/accounts.ts](src/accounts.ts) | Anvil deterministic accounts (DEPLOYER, RELAYER, PAYER, RECIPIENT). |
| [src/constants.ts](src/constants.ts) | Single source for chain id, paths, ports, ABIs, timeouts, FMD γ, asset id. |
| [src/scenario.ts](src/scenario.ts) | Test-side helpers — wallets, note recipes, ERC20 setup, indexer poll. |
| [src/utils.ts](src/utils.ts) | Hex codecs, deterministic counter, log, signal, pollUntil. |
| [src/setup.ts](src/setup.ts) | Vitest globalSetup hook. |
| [src/orchestrate.ts](src/orchestrate.ts) | Standalone CLI (commander) for `up` / `deploy` / `down` / `urls`. |
| [tests/](tests/) | Vitest specs. |

## Adding a new test

1. Drop a `*.test.ts` under [tests/](tests/).
2. Pull what you need from the SDK + `scenario.ts` + `utils.ts`:
   ```ts
   import { buildDeposit, RelayerClient, FmdClient, /* … */ } from "@lelantos-org/sdk";
   import { makeWallet, noteFor, rngForOutput, inputSlotFor, setupErc20 } from "../src/scenario";
   import { counter, hexToBytes, pollUntil } from "../src/utils";
   import { env } from "../src/env";
   import { RELAYER, PAYER } from "../src/accounts";
   ```
3. The vitest globalSetup has already booted the stack — `env.*` is
   populated. Just open clients and go:
   ```ts
   const fmd = new FmdClient(env.fmdUrl, env.chainId);
   const relayer = new RelayerClient(env.relayerUrl);
   ```
4. Each `it` should read as a story. SDK builders own the crypto +
   prove; `scenario.ts` owns the test-only scaffolding.

## Anvil deterministic accounts

| Index | Role | Address | Used by |
|---|---|---|---|
| 0 | Deployer | `0xf39F…2266` | `forge script Deploy.s.sol` |
| 1 | Relayer signer | `0x7099…79C8` | `RELAYER_CHAIN_*_SIGNER_KEY`, `pubInputs.relayer` |
| 2 | Payer | `0x3C44…93BC` | ERC20 source for deposits, bundle `payerAddress` |
| 3 | Recipient | `0x90F7…b906` | Withdraw destination, bundle `recipientAddress` |

## Caveats

- Single chain (`chain_id=31337`). Multi-chain not wired.
- Relayer uses in-process ark-circom prover. Slower than rapidsnark;
  acceptable for e2e.
- macOS + colima: `setup.ts` auto-resolves `DOCKER_HOST` from the active
  context. Ryuk reaper is disabled (vitest globalTeardown handles
  cleanup).
- If you `kill -9` the test process, run `just down` to prune any
  orphaned containers/networks.
