# e2e — Lazy-Root v2 Full-Stack Test

Boots the entire Lelantos stack (Postgres, anvil, contracts, all six
backend binaries, a TypeScript test runner) under docker compose and
exercises the deposit happy path end-to-end.

## What it does

1. Brings up Postgres + anvil (Cancun, chain-id 31337, deterministic mnemonic).
2. Runs a one-shot `deployer` that executes
   [contracts/script/Deploy.s.sol](../contracts/script/Deploy.s.sol) and
   prints the MASP / verifier / token addresses to stdout.
3. Captures those addresses into `.env`.
4. Boots ingester, fmd-indexer, explorer-indexer, fmd-webserver,
   explorer-webserver, relayer with the addresses fed via env vars (each
   binary's `apply_env_overlay` reads them).
5. Runs the runner container which uses the SDK to:
   - Build a real `transact_2x2` deposit proof.
   - POST it to the relayer's `/v1/transact`.
   - Wait for `fmd-indexer` to populate `notes` (`leaf_index ∈ {0, 1}`).
   - Wait for `explorer-indexer` to populate `tree_advances`.
   - Fetch `/v1/path/<cm>` from `fmd-webserver` and verify the recomputed
     root matches the chain's new root and `MASP.isKnownRoot()` is true.

## Prereqs

- Docker + Docker Compose v2.
- `just` (`brew install just`).
- Circuits build artifacts present at `circuits/build/` — run
  `cd circuits && just rebuild && just rebuild-tree` once.

## Commands

```bash
just test          # Full flow: deploy → backend → run tests → tear down.
just up            # Same as test but doesn't run runner. For poking.
just down          # Tear down + remove volume.
just logs <svc>    # Tail one service.
```

## Layout

| Path | Purpose |
|---|---|
| `compose.yml` | Full stack; profiles `deploy` (one-shot deployer) + `test` (runner). |
| `../backend/crates/relayer/Dockerfile` | Rust relayer + tree_update circuit artifacts baked in. |
| `Dockerfile.deployer` | Foundry + cast; runs `forge script Deploy.s.sol`. |
| `Dockerfile.runner` | Node + TS + the SDK + ethers; vitest. |
| `relayer.toml` | Relayer config with placeholders; runtime env overrides them. |
| `runner/` | TypeScript test driver (vitest). |
| `runner/src/deposit-bundle.ts` | Builds transact_2x2 proof using SDK. |
| `runner/tests/deposit-roundtrip.test.ts` | The actual e2e assertion. |

## Anvil deterministic accounts (mnemonic `test test test … junk`)

| Index | Role | Address | Key (last 8 bytes) |
|---|---|---|---|
| 0 | Deployer | `0xf39Fd6e51aad88F6F4ce6aB8827279cfFFb92266` | `0xac09…ff80` |
| 1 | Relayer signer (SNARK-bound) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6…690d` |
| 2 | Payer | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4…365a` |
| 3 | Recipient | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | n/a |

## Caveats

- Single chain (`chain_id=31337`). Multi-chain not yet wired.
- Relayer uses in-process ark-circom prover. Slower than rapidsnark;
  acceptable for e2e.
- All services share docker network `lelantos-e2e`. `just down` cleans
  it up. If you ctrl-C mid-run, run `just down` to fully reset.

## CI

`.github/workflows/e2e.yml` runs `just test` on PRs. Cache layers:
foundry submodule cache + cargo cache + npm cache.
