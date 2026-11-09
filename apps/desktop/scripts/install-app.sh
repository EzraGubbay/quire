#!/usr/bin/env bash
# Build the Quire desktop app and install it into the user's Applications folder.
#
# electron-builder already leaves the unpacked Quire.app under release/mac-arm64/, so we copy that
# directly — no need to mount the DMG. Defaults to the per-user ~/Applications (no sudo); override the
# destination with QUIRE_APP_DEST (e.g. /Applications, which needs write access).
#
# Gatekeeper: the build is unsigned (identity: null in electron-builder.yml), so the first launch needs
# right-click -> Open to get past Gatekeeper.
set -euo pipefail

APP_NAME="Quire"
DEST="${QUIRE_APP_DEST:-$HOME/Applications}"

# Repo root relative to this script (scripts -> desktop -> apps -> root), so there's no hardcoded path.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

pnpm --filter desktop dist

APP_PATH="$(find apps/desktop/release -maxdepth 2 -name "${APP_NAME}.app" -type d | head -n1)"
[ -n "$APP_PATH" ] || { echo "Built ${APP_NAME}.app not found under apps/desktop/release"; exit 1; }

mkdir -p "$DEST"
rm -rf "$DEST/${APP_NAME}.app"
cp -R "$APP_PATH" "$DEST/"
echo "Installed ${APP_NAME}.app -> $DEST"
echo "(unsigned build: first launch needs right-click -> Open)"
