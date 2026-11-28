#!/usr/bin/env bash
# Runs the render smoke inside a built runtime image, as the image's default user and with no network, so any
# asset the render needs must already be in the image. Usage: run-in-image.sh <image> <out-dir>
set -euo pipefail
image="${1:?image}"
out="${2:?out dir}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out"
chmod 777 "$out"
docker run --rm --network none -e GITHUB_ACTIONS -v "$here:/smoke:ro" -v "$out:/out" "$image" \
  node /smoke/run.mjs --app-root /app/apps/web --out /out
