#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_BIN="${GO_BIN:-$(command -v go || true)}"

if [[ -z "$GO_BIN" && -x "$HOME/.local/bin/go" ]]; then
  GO_BIN="$HOME/.local/bin/go"
fi
if [[ -z "$GO_BIN" || ! -x "$GO_BIN" ]]; then
  echo "Go is required to build VMD. Install Go or set GO_BIN." >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/bin"
cd "$ROOT_DIR"
exec env CGO_ENABLED=0 "$GO_BIN" build -trimpath -o "$ROOT_DIR/bin/voidapp-vmd" ./cmd/vmd
