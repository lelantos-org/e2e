set shell := ["bash", "-ceuo", "pipefail"]

ROOT := justfile_directory()

default:
    @just --list

# Run vitest. globalSetup boots the stack (postgres + anvil + 7 backends),
# host runs forge against anvil, then tests run against host-mapped ports.
test:
    cd "{{ROOT}}" && npm test

# Typecheck src/ + tests/ (nothing else compiles this package).
check:
    cd "{{ROOT}}" && npm run typecheck

# Run one file, or one test within it (still boots the whole stack).
test-file FILE *ARGS:
    cd "{{ROOT}}" && npx vitest run "{{FILE}}" {{ARGS}}

# Tail the streamed per-service container logs from the last/current run.
logs:
    tail -F "${E2E_LOG_DIR:-/tmp/e2e-logs}"/*.log

# Bring the stack up and keep it alive (ctrl-c to tear down). Useful when
# poking with curl from the host.
up:
    cd "{{ROOT}}" && npm run up

deploy:
    cd "{{ROOT}}" && npm run deploy

# Download tree_update_batch artifacts (wasm/r1cs/zkey) used by the relayer's
# prover. Version is taken from node_modules/@lelantos-org/circuits/package.json.
# Idempotent — skips when ./circuits/.version matches. Stack.up() also runs it.
fetch-circuits:
    cd "{{ROOT}}" && ./scripts/fetch-circuits.sh

# Remove a stack left behind by a hard kill (running or stopped).
# Ryuk reaps the stack by itself (see src/setup.ts), so this only matters when
# Ryuk was killed alongside the suite or switched off. Selects by testcontainers
# label rather than by image: a leaked container whose image has since been
# rebuilt runs untagged layers that no `--ancestor` filter would match.
# `lang=node` is what keeps it inside this suite — other testcontainers clients
# label their containers differently.
[doc('Remove a stack Ryuk did not clean up (fallback)')]
down:
    @docker ps -aq --filter label=org.testcontainers.lang=node | xargs -r docker rm -f
    @docker network prune -f --filter label=org.testcontainers=true > /dev/null
