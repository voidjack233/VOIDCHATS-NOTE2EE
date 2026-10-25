#!/usr/bin/env bash
# Read-only preflight for the bare-metal PM2/systemd VOID deployment.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
API="$ROOT/VOID0000-api"
OK=0 WARN=0 FAIL=0 SKIP=0

report() {
  local level="$1"
  shift
  printf '%-5s %s\n' "$level" "$*"
  case "$level" in
    OK) OK=$((OK + 1)) ;;
    WARN) WARN=$((WARN + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    SKIP) SKIP=$((SKIP + 1)) ;;
  esac
}

required_command() {
  if command -v "$1" >/dev/null 2>&1; then
    report OK "$1 is available"
  else
    report FAIL "$1 is not available in PATH"
  fi
}

printf 'VOID bare-metal requirements and readiness preflight (read-only)\n\n'

if [ "$(uname -s)" = Linux ]; then
  report OK "Linux; architecture: $(uname -m)"
else
  report FAIL 'Bare-metal setup is documented for Linux only'
fi
if command -v nproc >/dev/null 2>&1; then
  report OK "CPU: $(nproc) available logical processor(s); no validated minimum defined"
else
  report SKIP 'CPU count unavailable'
fi
if [ -r /proc/meminfo ]; then
  mem_kib="$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo)"
  if [[ "$mem_kib" =~ ^[0-9]+$ ]]; then
    if [ "$mem_kib" -lt 8388608 ]; then
      report WARN "RAM: $((mem_kib / 1024)) MiB; under 8 GiB guidance for the full stack"
    elif [ "$mem_kib" -lt 16777216 ]; then
      report WARN "RAM: $((mem_kib / 1024)) MiB; 16 GiB is suggested for more headroom"
    else
      report OK "RAM: $((mem_kib / 1024)) MiB; meets 16 GiB suggested headroom"
    fi
  else
    report SKIP 'RAM size could not be determined'
  fi
else
  report SKIP 'RAM size could not be determined'
fi
disk_kib="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
if [[ "$disk_kib" =~ ^[0-9]+$ ]]; then
  report OK "Repository filesystem free space: $((disk_kib / 1024)) MiB; no validated minimum defined"
else
  report SKIP 'Repository filesystem free space unavailable'
fi
report SKIP 'Database, MinIO and backup filesystem capacity/permissions not checked; locations may differ'
file_limit="$(ulimit -n 2>/dev/null || true)"
if [ -n "$file_limit" ]; then
  report OK "Current shell open-file limit: $file_limit; systemd service limits may differ"
else
  report SKIP 'Current shell open-file limit unavailable'
fi
report SKIP 'CPU suitability and systemd service limits require workload-specific assessment'

printf '\nRuntime tools\n'
for command in systemctl node pm2 mix elixir erl; do required_command "$command"; done
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null || true)"
  if [[ "$node_version" =~ ^v([0-9]+)\. ]]; then
    if [ "${BASH_REMATCH[1]}" -ge 20 ]; then
      report OK "Node $node_version meets the documented 20+ baseline (individual dependencies may differ)"
    else
      report FAIL "Node $node_version is older than the documented 20+ baseline"
    fi
  else
    report WARN 'Could not determine Node version'
  fi
fi
for command in npm go; do
  if command -v "$command" >/dev/null 2>&1; then
    report OK "$command build tooling is available"
  else
    report WARN "$command is missing; needed for relevant builds, not necessarily for existing artifacts"
  fi
done
report SKIP 'Elixir/Erlang, Scylla and other dependency version compatibility not validated'

printf '\nInstalled services and current state\n'
for mapping in \
  "postgres:${VOID_HOSTCTL_POSTGRES_UNIT:-postgresql.service}" \
  "scylla:${VOID_HOSTCTL_SCYLLA_UNIT:-scylla-server.service}" \
  "valkey:${VOID_HOSTCTL_VALKEY_UNIT:-valkey-server.service}" \
  "minio:${VOID_HOSTCTL_MINIO_UNIT:-minio.service}" \
  "nginx:${VOID_HOSTCTL_NGINX_UNIT:-nginx.service}" \
  "cloudflared:${VOID_HOSTCTL_CLOUDFLARED_UNIT:-cloudflared.service}"; do
  name="${mapping%%:*}"
  unit="${mapping#*:}"
  if ! command -v systemctl >/dev/null 2>&1; then
    report SKIP "$name unit check: systemctl unavailable"
  elif systemctl cat "$unit" </dev/null >/dev/null 2>&1; then
    state="$(systemctl is-active "$unit" </dev/null 2>/dev/null || true)"
    if [ "$state" = active ]; then
      report OK "$name: $unit is installed and active (not a health check)"
    else
      report WARN "$name: $unit is installed but ${state:-unknown}; expected when parked"
    fi
  elif [ "$name" = nginx ] || [ "$name" = cloudflared ]; then
    report WARN "$name: $unit not found; required only for this public-edge setup"
  else
    report FAIL "$name: $unit not found for this bare-metal profile"
  fi
done
report SKIP 'Live database authentication, MinIO buckets and migration readiness not checked'

printf '\nVOID files and configuration\n'
for relative in \
  ecosystem.config.cjs \
  dist/server/entrypoints/account-server.js \
  dist/server/entrypoints/message-server.js \
  dist/server/entrypoints/social-server.js \
  dist/server/entrypoints/conversation-server.js \
  dist/server/entrypoints/worker-server.js \
  startup/run-phoenix-gateway.sh; do
  if [ -r "$API/$relative" ]; then report OK "API file available: $relative"
  else report FAIL "API file missing or unreadable: $relative"; fi
done
for relative in bin/voidapp-vmd bin/voidapp-media-worker; do
  if [ -x "$API/$relative" ]; then report OK "Executable available: $relative"
  else report FAIL "Executable missing or not executable: $relative"; fi
done
if [ -r "$ROOT/VOID0000-www/dist/index.html" ]; then
  report OK 'Repository frontend build exists (deployed web root not verified)'
else
  report WARN 'Repository frontend build not found; an independently published web root may still exist'
fi

if [ ! -r "$API/.env" ]; then
  report WARN 'API .env is missing or unreadable; process environment may instead supply configuration'
elif ! command -v node >/dev/null 2>&1 || [ ! -d "$API/node_modules/dotenv" ]; then
  report SKIP 'Cannot inspect .env key presence safely without Node and the API dotenv dependency'
else
  # dotenv parses rather than executes the file. Only key names and statuses
  # leave this process; never display values, errors, or the environment.
  config_report="$(node - "$API/.env" "$API/node_modules/dotenv" <<'NODE' 2>/dev/null
const fs = require('fs');
const dotenv = require(process.argv[3]);
const values = dotenv.parse(fs.readFileSync(process.argv[2]));
const keys = ['PGUSER', 'PGHOST', 'PGDATABASE', 'PGPASSWORD', 'SCYLLA_HOST',
  'SCYLLA_KEYSPACE', 'VALKEY_HOST', 'MINIO_ENDPOINT', 'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY', 'FRONT_URL', 'ACCESS_SECRET', 'REFRESH_SECRET',
  'CSRF_ENCRYPTION_KEY', 'TOTP_ENCRYPTION_KEY', 'TWO_FACTOR_CODE_SECRET',
  'PHX_SECRET_KEY_BASE'];
for (const key of keys) {
  const value = process.env[key] ?? values[key];
  const state = !value ? 'missing' : /^(replace[-_ ]|change[-_ ]?me|your[-_ ])/i.test(value.trim()) ? 'placeholder' : 'present';
  console.log(`${state} ${key}`);
}
NODE
  )" || config_report='unavailable'
  if [ "$config_report" = unavailable ]; then
    report SKIP 'Could not inspect .env key presence; no values were printed'
  else
    while IFS=' ' read -r state key; do
      case "$state" in
        present) report OK "$key is set (value and validity not verified)" ;;
        missing|placeholder) report WARN "$key is $state in the file/process environment; defaults or other runtime sources may apply" ;;
      esac
    done <<< "$config_report"
  fi
fi
report SKIP 'Secret strength, exact runtime configuration, Phoenix dependencies and app health not verified'

printf '\nPorts\n'
if command -v ss >/dev/null 2>&1; then
  for port in 3001 3002 3004 3005 3006 3007 4001 5432 6379 9042 9000; do
    listeners="$(ss -ltnH "( sport = :$port )" </dev/null 2>/dev/null || true)"
    if [ -z "$listeners" ]; then
      report WARN "TCP $port is not listening locally; expected when its service is stopped"
    else
      report WARN "TCP $port is listening; ownership, binding safety and health not verified"
    fi
  done
else
  report SKIP 'Port checks unavailable (ss not found)'
fi
report SKIP 'Public DNS, TLS and tunnel connectivity not checked'

printf '\nSummary: %s OK, %s warning(s), %s failure(s), %s not checked.\n' "$OK" "$WARN" "$FAIL" "$SKIP"
printf 'This is a bare-metal preflight, not proof the application is healthy or production-ready.\n'
[ "$FAIL" -eq 0 ]
