set shell := ["bash", "-ceuo", "pipefail"]

ROOT := justfile_directory()
DC := "docker compose -f " + ROOT / "compose.yml"
ENV_FILE := ROOT / ".env"

default:
    @just --list

# One-shot: deploy + bring backend up + run runner. Tear down on success.
test: up
    @echo "==> waiting 5s for services to settle"
    sleep 5
    @echo "==> running e2e tests"
    {{DC}} --profile test run --rm runner
    just down

# Bring everything up but don't run tests. Useful for poking with curl
# from the host (relayer @ :3003, fmd @ :3001, explorer @ :3002).
up: deploy
    @echo "==> backend services"
    {{DC}} up -d --wait ingester fmd-indexer explorer-indexer fmd-webserver explorer-webserver relayer

up-build: deploy-build
    @echo "==> backend services"
    {{DC}} up -d --no-deps --build --wait ingester fmd-indexer explorer-indexer fmd-webserver explorer-webserver relayer
    @echo "==> rebuilding runner image"
    {{DC}} --profile test build runner

down:
    -{{DC}} --profile test --profile deploy down -v --remove-orphans
    rm -f "{{ENV_FILE}}"

logs service:
    {{DC}} logs -f {{service}}

# Postgres + anvil + one-shot deployer. Captures deployer stdout into .env.
deploy:
    @touch "{{ENV_FILE}}"
    @echo "==> postgres + anvil"
    {{DC}} up -d --wait postgres anvil
    @echo "==> deploying contracts"
    {{DC}} --profile deploy run --rm -T deployer \
        | sed -E 's/\x1b\[[0-9;]*m//g' \
        | grep -oE '(VERIFIER|TREE_UPDATE_VERIFIER|MASP|TOKEN_[0-9]+)=0x[0-9a-fA-F]{40}' \
        | sort -u \
        > "{{ENV_FILE}}"
    @echo "==> .env:"
    @cat "{{ENV_FILE}}"

# Same as `deploy` but rebuilds the deployer image first. Required whenever
# contracts/ (incl. circuits/build/Verifier.sol) changed, since the deployer
# Dockerfile COPYs contracts/ at image-build time — a stale image would
# redeploy an old verifier and the spend proof would revert with
# ProofRejected() (0xc3b0d8cd).
deploy-build:
    @echo "==> rebuilding deployer image"
    {{DC}} --profile deploy build deployer
    @just deploy
