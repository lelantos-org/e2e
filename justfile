set shell := ["bash", "-ceuo", "pipefail"]

ROOT := justfile_directory()

default:
    @just --list

# Run vitest. globalSetup boots the stack (postgres, anvil, oracle and the
# backend services), runs forge against anvil from the host, then the tests run
# against the host-mapped ports.
test:
    cd "{{ROOT}}" && npm test

# Typecheck src/ and tests/; nothing else compiles this package.
check:
    cd "{{ROOT}}" && npm run typecheck

# Run one file, or one test within it. Still boots the whole stack.
test-file FILE *ARGS:
    cd "{{ROOT}}" && npx vitest run "{{FILE}}" {{ARGS}}

# Tail the streamed per-service container logs from the last/current run.
logs:
    tail -F "${E2E_LOG_DIR:-/tmp/e2e-logs}"/*.log

# Bring the stack up and hold it until ctrl-c, for querying it from the host.
up:
    cd "{{ROOT}}" && npm run up

deploy:
    cd "{{ROOT}}" && npm run deploy

# Download the tree_update_batch artifacts (wasm/r1cs/zkey) the relayer's prover
# reads. The version comes from node_modules/@lelantos-org/circuits/package.json.
# Idempotent: skips when ./circuits/.version matches. Stack.up() also runs it.
fetch-circuits:
    cd "{{ROOT}}" && ./scripts/fetch-circuits.sh

# Remove a stack left behind by a hard kill, running or stopped. Ryuk reaps the
# stack on its own (see src/setup.ts), so this matters only when Ryuk was killed
# alongside the suite or switched off. Selects by testcontainers label rather
# than by image: a leaked container whose image has since been rebuilt runs
# untagged layers that no `--ancestor` filter matches. `lang=node` keeps the
# selection inside this suite; other testcontainers clients label differently.
[doc('Remove a stack Ryuk did not clean up (fallback)')]
down:
    @docker ps -aq --filter label=org.testcontainers.lang=node | xargs -r docker rm -f
    @docker network prune -f --filter label=org.testcontainers=true > /dev/null
