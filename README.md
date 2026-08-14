# E2E — full-stack integration tests

Boots the Lelantos stack (Postgres, Anvil, seven backend services) with
[testcontainers-node][tc] and exercises deposit, shielded transfer, withdraw,
swap and FMD-driven sync end to end. The test process owns container
lifecycle, so failures surface as host-side stack traces and no image rebuild
is needed to add logging.

## Tests

Files run serially in path order, so `tests/` precedes `tests/edge/` and
`tests/negative/`.

| Spec | Cases | Covers |
|---|---|---|
| [batch-flush](tests/batch-flush.test.ts) | 1 | Three deposits submitted in parallel, drained by the relayer into a single `flushBatch` transaction. |
| [client-resync](tests/client-resync.test.ts) | 2 | Two deposits and two transfers, then a wallet built from the key alone reconstructs the recipient's balance from the chunk feed. |
| [deposit-native](tests/deposit-native.test.ts) | 4 | `asEth` deposit through `NativeAdapter`: coin spent rather than WETH, pool credited, no residue on the adapter, fee accrued, resulting note spendable. Skipped without a native adapter. |
| [double-spend](tests/double-spend.test.ts) | 3 | A note is deposited and spent, then replayed from a stale wallet and rejected. |
| [full-flow](tests/full-flow.test.ts) | 6 | Deposit, shielded transfer with change, withdraw, treasury fee accrual on both legs, and recovery of the recipient's balance by a fresh client. Includes a Permit2 `maxTotal` revert. |
| [multi-asset](tests/multi-asset.test.ts) | 5 | Deposits and withdrawals across WETH and mDAI, with per-asset fee accrual and net-of-fee recipient amounts. |
| [swap](tests/swap.test.ts) | 4 | Quote resolution against the allowlisted UniV3 adapter and a shielded swap producing a note in the output asset; refuses a non-allowlisted adapter and one that under-delivers against `minOut`. Skipped without `SWAP_WRAPPER_ADDRESS`. |
| [two-input-merge](tests/two-input-merge.test.ts) | 2 | A transfer consuming two input notes and producing one output. |
| [withdraw-native](tests/withdraw-native.test.ts) | 3 | `withdrawEth` unwraps through `NativeAdapter`: recipient receives coin with no WETH movement, fees accrue in WETH. |
| [edge/concurrent-spends](tests/edge/concurrent-spends.test.ts) | 1 | Two parallel spends of the same note; exactly one succeeds. |
| [negative/expired-permit](tests/negative/expired-permit.test.ts) | 1 | Deposit reverts when the Permit2 deadline has passed. |
| [negative/zero-value-deposit](tests/negative/zero-value-deposit.test.ts) | 1 | `Wallet.deposit` rejects a zero amount. |
