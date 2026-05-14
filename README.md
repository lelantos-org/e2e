# e2e — host-driven full-stack tests

Boots the full Lelantos stack (postgres + anvil + the six backend
services) via [testcontainers-node][tc] and exercises deposit → shielded
transfer → withdraw → swap → fmd-driven sync end-to-end. Container
lifecycle is owned by the test process, not docker compose; failures
surface host-side stack traces and `console.log` works without
rebuilding any image.

[tc]: https://node.testcontainers.org/

## Topology

```
host process (vitest globalSetup)
  ├─ stack.up()            postgres + anvil (testcontainers)
  ├─ stack.deploy()        forge script DeployTest.s.sol → addresses
  ├─ stack.upBackend()     ingester, fmd-indexer, explorer-indexer,
  │                         fmd-webserver, explorer-webserver, relayer,
  │                         metaquoter (when swap enabled)
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
  docker build -f backend/crates/metaquoter/Dockerfile -t lelantos/metaquoter:dev .
  ```
- Circuit artifacts at `circuits/build/2x2_final.zkey` + `circuits/build/2x2_js/2x2.wasm` —
  produced by `cd circuits && just rebuild`.

## Commands

```bash
just test       # vitest globalSetup → stack up → forge deploy → all suites → tear down
just up         # bring stack up + keep alive (ctrl-c to drop). prints urls.
just deploy     # bring up postgres+anvil, deploy contracts, print addresses, tear down
just down       # best-effort docker prune for orphan containers/networks
```

`E2E_KEEP_ALIVE=1 just test` leaves the stack running on test exit so
you can `curl` the indexers / mapped ports for manual inspection.

## Layout

| Path | Purpose |
|---|---|
| [config/](config/) | TOML configs mounted into backend containers. |
| [src/](src/) | TS test driver + stack lifecycle. Single npm package. |
| [src/stack.ts](src/stack.ts) | `Stack` class — three-phase lifecycle (up / deploy / upBackend / down). |
| [src/services.ts](src/services.ts) | Declarative `ServiceSpec` table for every container. |
| [src/accounts.ts](src/accounts.ts) | Anvil deterministic accounts (DEPLOYER, RELAYER, PAYER, RECIPIENT). |
| [src/constants.ts](src/constants.ts) | Chain id, paths, ports, ABIs, timeouts, `POLL` budgets, FMD γ, `ASSETS` registry, `DEAD_ADDRESS`. |
| [src/harness.ts](src/harness.ts) | `setupHarness`, `fundPayerForAsset`, `submitIntentDirect`; one-stop re-export hub for tests. |
| [src/wallet.ts](src/wallet.ts) | `createTestWallet` (SDK Wallet factory) + `TEST_NSK` per-file NSK registry. |
| [src/scenario.ts](src/scenario.ts) | Test-side helpers — `makeWallet`, note recipes, ERC20 setup, `snapshotBalances`, `expectBalanceDeltas`, indexer poll. |
| [src/explorer-client.ts](src/explorer-client.ts) | Typed thin client over the explorer HTTP API. |
| [src/swap-harness.ts](src/swap-harness.ts) | Shielded-swap recipes layered on `Harness`. |
| [src/negative.ts](src/negative.ts) | Pure builders for malformed intents / paths / permits. |
| [src/utils.ts](src/utils.ts) | Hex codecs, deterministic `counter`, `log`, `pollUntil`, `expectRevert`. |
| [src/setup.ts](src/setup.ts) | Vitest globalSetup hook. |
| [src/orchestrate.ts](src/orchestrate.ts) | Standalone CLI (commander) for `up` / `deploy` / `down`. |
| [tests/](tests/) | Happy-path vitest specs. |
| [tests/negative/](tests/negative/) | Revert-path specs (`expectRevert` + `src/negative.ts` builders). |
| [tests/edge/](tests/edge/) | Concurrency / boundary specs. |

## Adding a new test

1. Drop a `*.test.ts` under [tests/](tests/) (or `tests/negative/` / `tests/edge/`).
2. Add a fresh prefix to `TEST_NSK` in [src/wallet.ts](src/wallet.ts); each
   file uses a distinct NSK so wallets stay isolated on the shared anvil.
3. Pull everything from `harness.ts`:
   ```ts
   import {
       ASSET, ASSETS, POLL, TEST_NSK,
       createTestWallet, fundPayerForAsset, setupHarness,
       snapshotBalances, expectBalanceDeltas, expectRevert,
       type Harness,
   } from "../src/harness";
   ```
4. Fund the payer up front, then drive the SDK `Wallet`:
   ```ts
   const { alice: ALICE_NSK } = TEST_NSK.myCase;

   beforeAll(async () => {
       h = await setupHarness();
       erc20 = await fundPayerForAsset(h, ASSET, withFee(100n));
       alice = await createTestWallet(h, ALICE_NSK);
   });

   it("deposit lands a note", async () => {
       const r = await alice.deposit({ amount: 50n, asset: ASSET });
       await alice.awaitCommitments(r.cm, POLL.COMMITMENT);
       expect(await alice.balance(ASSET)).toBe(50n);
   });
   ```
5. Each `it` should read as a story. SDK builders own crypto + prove;
   scenario / harness own the test-only scaffolding.

### Negative tests

- Use [`expectRevert(promise, /reason/i)`](src/utils.ts) to assert a
  specific revert reason, not just any throw.
- Use [`src/negative.ts`](src/negative.ts) builders (`expiredPermitDeadline`,
  `mutateOutCm`, `mutateMerklePath`, `mutateAux`) to corrupt
  intents/paths cleanly.
- The SDK `Wallet` clamps inputs; bypass it via `submitIntentDirect` when
  you need malformed `maxTotal` / `deadline` / aux.

## Anvil deterministic accounts

| Index | Role | Address | Used by |
|---|---|---|---|
| 0 | Deployer | `0xf39F…2266` | `forge script DeployTest.s.sol` |
| 1 | Relayer signer | `0x7099…79C8` | `RELAYER_CHAIN_*_SIGNER_KEY`, `pubInputs.relayer` |
| 2 | Payer | `0x3C44…93BC` | ERC20 source for deposits, bundle `payerAddress` |
| 3 | Recipient | `0x90F7…b906` | Withdraw destination, bundle `recipientAddress` |

## Assets

Registry mirrors `contracts/test/fixtures/asset_registry.json`. Import
from [`src/constants.ts`](src/constants.ts) (or via harness re-export):

| Id | Const | Token | Notes |
|---|---|---|---|
| 1 | `ASSETS.WETH` | WETH9 mock | No public `mint`; `fundPayerForAsset` wraps ETH via `deposit()`. |
| 2 | `ASSETS.MDAI` | MockERC20 | Default for `feeFor` / `baseAmt` / `withFee`. Exported as `ASSET`. |
| 3 | `ASSETS.MWBTC` | MockERC20 | Scale = 1 (8-decimal). |

## Caveats

- Single chain (`chain_id=31337`). Multi-chain not wired.
- Relayer uses in-process ark-circom prover. Slower than rapidsnark;
  acceptable for e2e.
- `fileParallelism: false` in [vitest.config.ts](vitest.config.ts) —
  files share one anvil + indexer DB, so they run serially.
- macOS + colima: `setup.ts` auto-resolves `DOCKER_HOST` from the active
  context. Ryuk reaper is disabled (vitest globalTeardown handles
  cleanup).
- If you `kill -9` the test process, run `just down` to prune any
  orphaned containers/networks.
