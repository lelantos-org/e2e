#!/usr/bin/env bash
# Fetch tree_update_batch circuit artifacts (wasm + r1cs + zkey) from the
# @lelantos-org/circuits GitHub release into ./circuits/. The relayer container
# bind-mounts this directory at /circuits and reads it at startup.
#
# Version is taken from node_modules/@lelantos-org/circuits/package.json so it
# always matches the npm-installed SDK circuit set. Override with $VERSION.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST="${E2E_DIR}/circuits"
REPO="lelantos-org/circuits"
ASSETS=(tree_update_batch.wasm tree_update_batch.r1cs tree_update_batch_final.zkey)

VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
    PKG_JSON="${E2E_DIR}/node_modules/@lelantos-org/circuits/package.json"
    if [ ! -f "$PKG_JSON" ]; then
        echo "ERROR: $PKG_JSON not found — run 'npm install' first, or set \$VERSION" >&2
        exit 1
    fi
    PKG_VERSION="$(node -p "require('$PKG_JSON').version")"
    VERSION="v${PKG_VERSION}"
fi

# Idempotent: skip when cached version matches.
if [ -f "${DEST}/.version" ] && [ "$(cat "${DEST}/.version")" = "$VERSION" ]; then
    have_all=1
    for a in "${ASSETS[@]}"; do
        [ -s "${DEST}/${a}" ] || { have_all=0; break; }
    done
    if [ "$have_all" = "1" ]; then
        echo "circuits ${VERSION} already present in ${DEST}"
        exit 0
    fi
fi

command -v gh >/dev/null || { echo "ERROR: gh CLI required" >&2; exit 1; }

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading circuits ${VERSION} from ${REPO}"
patterns=()
for a in "${ASSETS[@]}"; do patterns+=(--pattern "$a"); done
gh release download "$VERSION" --repo "$REPO" "${patterns[@]}" --dir "$TMP"

for a in "${ASSETS[@]}"; do
    [ -s "${TMP}/${a}" ] || { echo "ERROR: ${a} missing from release ${VERSION}" >&2; exit 1; }
    mv "${TMP}/${a}" "${DEST}/${a}"
done
echo "$VERSION" > "${DEST}/.version"
echo "==> circuits ${VERSION} → ${DEST}"
