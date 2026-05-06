set shell := ["bash", "-ceuo", "pipefail"]

ROOT := justfile_directory()

default:
    @just --list

# Run vitest. globalSetup boots the stack (postgres + anvil + 6 backends),
# host runs forge against anvil, then tests run against host-mapped ports.
test:
    cd "{{ROOT}}" && npm test

# Bring the stack up and keep it alive (ctrl-c to tear down). Useful when
# poking with curl from the host.
up:
    cd "{{ROOT}}" && npm run up

deploy:
    cd "{{ROOT}}" && npm run deploy

# best-effort cleanup of any leaked containers from a kill -9 path
down:
    docker container prune -f >/dev/null
    docker network prune -f >/dev/null
