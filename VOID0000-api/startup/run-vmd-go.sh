#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT_DIR/bin/voidapp-vmd"

if [[ ! -x "$BINARY" ]]; then
  echo "VMD Go binary is missing. Run npm run build:vmd first." >&2
  exit 1
fi

cd "$ROOT_DIR"
exec "$BINARY"
