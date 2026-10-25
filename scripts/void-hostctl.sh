#!/usr/bin/env bash
# Control the dedicated bare-metal VOID host stack. This is intentionally
# separate from voidctl, which controls the Compose deployment topology.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/VOID0000-api"

# These defaults match the dedicated VOID production host. They may be
# overridden only when a host installed a service under a different unit name.
CLOUDFLARED_UNIT="${VOID_HOSTCTL_CLOUDFLARED_UNIT:-cloudflared.service}"
NGINX_UNIT="${VOID_HOSTCTL_NGINX_UNIT:-nginx.service}"
POSTGRES_UNIT="${VOID_HOSTCTL_POSTGRES_UNIT:-postgresql.service}"
# Ubuntu's PostgreSQL generator may show this cluster as enabled-runtime when
# its parent service is disabled. It is reported for clarity, but the parent
# unit above remains the boot gate controlled by this script.
POSTGRES_CLUSTER_UNIT="${VOID_HOSTCTL_POSTGRES_CLUSTER_UNIT:-postgresql@16-main.service}"
SCYLLA_UNIT="${VOID_HOSTCTL_SCYLLA_UNIT:-scylla-server.service}"
VALKEY_UNIT="${VOID_HOSTCTL_VALKEY_UNIT:-valkey-server.service}"
MINIO_UNIT="${VOID_HOSTCTL_MINIO_UNIT:-minio.service}"
PM2_UNIT="${VOID_HOSTCTL_PM2_UNIT:-pm2-${USER}.service}"

readonly VOID_PM2_APPS=(
  voidapp-api
  voidapp-message-service
  voidapp-vmd-service
  voidapp-media-worker
  voidapp-social-profile-service
  voidapp-conversation-service
  voidapp-gateway-phoenix
  voidapp-worker-service
)

DRY_RUN=false
ASSUME_YES=false

log() { printf '[void-hostctl] %s\n' "$*"; }
fail() { printf '[void-hostctl] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/void-hostctl.sh <command> [target] [--yes] [--dry-run]

Commands:
  status                 Show service, PM2, boot, and listener state (read-only).
  requirements           Check bare-metal requirements and readiness (read-only).
  park                   Stop and disable the complete dedicated VOID stack.
  wake                   Enable and start the complete dedicated VOID stack.
  start <target>         Start a target without changing its boot setting.
  stop <target>          Stop a target without changing its boot setting.
  enable <target>        Enable a target at boot; for apps, save the PM2 list.
  disable <target>       Disable a target at boot; for apps, remove VOID PM2 apps.

Targets: all, apps, edge, cloudflared, nginx, postgres, scylla, valkey, minio

Mutating commands ask for a confirmation unless --yes is supplied. --dry-run
prints the commands that would run and never changes service state.

This tool never reboots or powers off the machine, never deletes data, and
only controls the fixed VOID service allowlist above.
EOF
}

run() {
  if "$DRY_RUN"; then
    printf 'DRY RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

unit_for() {
  case "$1" in
    cloudflared) printf '%s\n' "$CLOUDFLARED_UNIT" ;;
    nginx) printf '%s\n' "$NGINX_UNIT" ;;
    postgres) printf '%s\n' "$POSTGRES_UNIT" ;;
    scylla) printf '%s\n' "$SCYLLA_UNIT" ;;
    valkey) printf '%s\n' "$VALKEY_UNIT" ;;
    minio) printf '%s\n' "$MINIO_UNIT" ;;
    *) return 1 ;;
  esac
}

require_known_target() {
  case "$1" in
    all|apps|edge|cloudflared|nginx|postgres|scylla|valkey|minio) ;;
    *) fail "Unknown target '$1'. Run with --help for the allowlist." ;;
  esac
}

require_units() {
  local name unit
  for name in cloudflared nginx postgres scylla valkey minio; do
    unit="$(unit_for "$name")"
    systemctl cat "$unit" >/dev/null 2>&1 || fail "Expected VOID unit is not installed: $unit (for $name)."
  done
}

require_target_units() {
  local target="$1" name unit
  case "$target" in
    apps) return ;;
    all) require_units; return ;;
    edge) for name in cloudflared nginx; do
      unit="$(unit_for "$name")"
      systemctl cat "$unit" >/dev/null 2>&1 || fail "Expected VOID unit is not installed: $unit (for $name)."
    done; return ;;
  esac
  unit="$(unit_for "$target")"
  systemctl cat "$unit" >/dev/null 2>&1 || fail "Expected VOID unit is not installed: $unit (for $target)."
}

systemd_state() {
  local verb="$1" unit="$2" state
  state="$(systemctl "$verb" "$unit" 2>/dev/null || true)"
  printf '%s' "${state:-unknown}"
}

pm2_json() {
  command -v pm2 >/dev/null 2>&1 || return 1
  # Keep PM2 from consuming a queued answer from the interactive menu.
  pm2 jlist </dev/null 2>/dev/null
}

pm2_summary() {
  if ! command -v pm2 >/dev/null 2>&1; then
    printf 'pm2 command not found'
    return
  fi
  if ! pm2_json | VOID_HOSTCTL_PM2_APP_NAMES="$(printf '%s\n' "${VOID_PM2_APPS[@]}")" node -e '
    const apps = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const ours = new Set(process.env.VOID_HOSTCTL_PM2_APP_NAMES.split("\n"));
    const selected = apps.filter((app) => ours.has(app.name));
    console.log(selected.length === 0 ? "no VOID apps registered" : selected.map((app) => `${app.name}:${app.pm2_env?.status || "unknown"}`).join(", "));
  '; then
    printf 'PM2 list unavailable'
  fi
}

unknown_pm2_apps() {
  pm2_json | VOID_HOSTCTL_PM2_APP_NAMES="$(printf '%s\n' "${VOID_PM2_APPS[@]}")" node -e '
    const apps = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const ours = new Set(process.env.VOID_HOSTCTL_PM2_APP_NAMES.split("\n"));
    for (const app of apps) if (!ours.has(app.name)) console.log(app.name);
  '
}

pm2_dump_summary() {
  local dump="${PM2_HOME:-$HOME/.pm2}/dump.pm2"
  if [ ! -e "$dump" ]; then
    printf 'no saved PM2 dump'
    return
  fi
  VOID_HOSTCTL_PM2_APP_NAMES="$(printf '%s\n' "${VOID_PM2_APPS[@]}")" node -e '
    const fs = require("fs");
    const apps = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const ours = new Set(process.env.VOID_HOSTCTL_PM2_APP_NAMES.split("\n"));
    const selected = apps.filter((app) => ours.has(app.name));
    console.log(selected.length === 0 ? "no VOID apps saved" : `${selected.length} VOID app(s) saved`);
  ' "$dump" 2>/dev/null || printf 'unreadable PM2 dump'
}

status() {
  local name unit active enabled
  printf '%-13s %-34s %-12s %s\n' 'SERVICE' 'UNIT' 'ACTIVE' 'ENABLED'
  for name in cloudflared nginx postgres scylla valkey minio; do
    unit="$(unit_for "$name")"
    active="$(systemd_state is-active "$unit")"
    enabled="$(systemd_state is-enabled "$unit")"
    printf '%-13s %-34s %-12s %s\n' "$name" "$unit" "$active" "$enabled"
  done
  if systemctl cat "$POSTGRES_CLUSTER_UNIT" >/dev/null 2>&1; then
    printf '%-13s %-34s %-12s %s\n' 'postgres-cluster' "$POSTGRES_CLUSTER_UNIT" "$(systemd_state is-active "$POSTGRES_CLUSTER_UNIT")" "$(systemd_state is-enabled "$POSTGRES_CLUSTER_UNIT")"
  fi
  printf '%-13s %-34s %-12s %s\n' 'pm2' "$PM2_UNIT" "$(systemd_state is-active "$PM2_UNIT")" "$(systemd_state is-enabled "$PM2_UNIT")"
  printf '\nPM2 live:  %s\n' "$(pm2_summary)"
  printf 'PM2 saved: %s\n' "$(pm2_dump_summary)"
  printf 'VOID listeners: '
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH '( sport = :80 or sport = :443 or sport = :3001 or sport = :3002 or sport = :3004 or sport = :3005 or sport = :3006 or sport = :3007 or sport = :4001 or sport = :5432 or sport = :6379 or sport = :9042 or sport = :9000 )' 2>/dev/null | awk 'END { if (NR == 0) print "none"; else print NR " listener(s)" }'
  else
    printf 'not checked (ss is unavailable)\n'
  fi
}

confirm() {
  local action="$1"
  if "$ASSUME_YES" || "$DRY_RUN"; then return; fi
  printf 'This will %s. Type %q to continue: ' "$action" "$action"
  local answer
  read -r answer
  [ "$answer" = "$action" ] || fail "Cancelled."
}

sudo_systemctl() { run sudo systemctl "$@"; }

stop_apps() {
  command -v pm2 >/dev/null 2>&1 || fail "pm2 is required to control VOID application processes."
  run pm2 stop "${VOID_PM2_APPS[@]}" || true
}

delete_void_apps_and_save() {
  local unknown
  unknown="$(unknown_pm2_apps || true)"
  [ -z "$unknown" ] || fail "Refusing to overwrite the PM2 dump because it contains non-VOID apps: $unknown"
  run pm2 delete "${VOID_PM2_APPS[@]}" || true
  run pm2 save --force
}

start_apps() {
  [ -f "$API_DIR/ecosystem.config.cjs" ] || fail "Missing PM2 ecosystem file: $API_DIR/ecosystem.config.cjs"
  run pm2 start "$API_DIR/ecosystem.config.cjs" --update-env
}

save_apps() {
  local unknown
  unknown="$(unknown_pm2_apps || true)"
  [ -z "$unknown" ] || fail "Refusing to overwrite the PM2 dump because it contains non-VOID apps: $unknown"
  run pm2 save
}

for_each_target_unit() {
  local target="$1" callback="$2" name
  case "$target" in
    all) for name in cloudflared nginx postgres scylla valkey minio; do "$callback" "$name"; done ;;
    edge) for name in cloudflared nginx; do "$callback" "$name"; done ;;
    apps) "$callback" apps ;;
    *) "$callback" "$target" ;;
  esac
}

start_target() {
  local target="$1" name unit
  case "$target" in
    all)
      start_target postgres; start_target scylla; start_target valkey; start_target minio
      start_apps
      start_target nginx; start_target cloudflared
      return
      ;;
    edge)
      start_target nginx; start_target cloudflared
      return
      ;;
    apps) start_apps; return ;;
  esac
  for_each_target_unit "$target" start_target_one
}
start_target_one() {
  local name="$1" unit
  unit="$(unit_for "$name")"
  sudo_systemctl start "$unit"
}

stop_target() {
  local target="$1"
  case "$target" in
    all)
      stop_apps
      stop_target edge
      stop_target minio; stop_target valkey; stop_target scylla; stop_target postgres
      return
      ;;
    edge)
      stop_target cloudflared; stop_target nginx
      return
      ;;
    apps) stop_apps; return ;;
  esac
  for_each_target_unit "$target" stop_target_one
}
stop_target_one() {
  local name="$1" unit
  unit="$(unit_for "$name")"
  sudo_systemctl stop "$unit"
}

enable_target() {
  local target="$1"
  if [ "$target" = all ]; then
    for_each_target_unit all enable_target_one
    save_apps
    return
  fi
  if [ "$target" = apps ]; then save_apps; return; fi
  for_each_target_unit "$target" enable_target_one
}
enable_target_one() {
  local name="$1" unit
  unit="$(unit_for "$name")"
  sudo_systemctl enable "$unit"
}

disable_target() {
  local target="$1"
  if [ "$target" = all ]; then
    delete_void_apps_and_save
    for_each_target_unit all disable_target_one
    return
  fi
  if [ "$target" = apps ]; then delete_void_apps_and_save; return; fi
  for_each_target_unit "$target" disable_target_one
}
disable_target_one() {
  local name="$1" unit
  unit="$(unit_for "$name")"
  sudo_systemctl disable "$unit"
}

park() {
  confirm park
  require_units
  stop_target all
  disable_target all
  log 'VOID is parked. Run status to verify the final state.'
}

wake() {
  confirm wake
  require_units
  # Start stateful dependencies before PM2, then expose the healthy stack last.
  for_each_target_unit all enable_target_one
  start_target all
  save_apps
  log 'VOID start requested. Run status and scripts/check-health.sh before public use.'
}

interactive_menu() {
  cat <<'EOF'

VOID bare-metal control
  1) status
  2) park (stop + disable all VOID services)
  3) wake (enable + start all VOID services)
  4) start one target
  5) stop one target
  6) enable one target
  7) disable one target
  8) requirements and readiness check
  q) quit
EOF
  printf 'Choose an action: '
  local choice target command
  read -r choice || return 2
  case "$choice" in
    1) status ;;
    2) park ;;
    3) wake ;;
    8) bash "$SCRIPT_DIR/void-requirements.sh" ;;
    4|5|6|7)
      case "$choice" in 4) command=start;; 5) command=stop;; 6) command=enable;; 7) command=disable;; esac
      printf 'Target (all, apps, edge, cloudflared, nginx, postgres, scylla, valkey, minio): '
      read -r target || return 2
      require_known_target "$target"
      confirm "$command $target"
      require_target_units "$target"
      "${command}_target" "$target"
      ;;
    q|Q) return 2 ;;
    *) fail 'Unknown menu selection.' ;;
  esac
}

interactive_loop() {
  local result
  while :; do
    # Run an action in a subshell so a failed action returns to this menu
    # instead of closing the operator's control session.
    if (interactive_menu); then
      continue
    else
      result=$?
    fi
    if [ "$result" -eq 2 ]; then
      log 'Exiting VOID host control.'
      return 0
    fi
    log 'Action failed; returning to the menu.'
  done
}

main() {
  local command="" target=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes) ASSUME_YES=true ;;
      --dry-run) DRY_RUN=true ;;
      --help|-h) usage; return ;;
      *)
        if [ -z "$command" ]; then command="$1"
        elif [ -z "$target" ]; then target="$1"
        else fail "Unexpected argument: $1"; fi
        ;;
    esac
    shift
  done

  [ -n "$command" ] || { interactive_loop; return; }
  case "$command" in
    status) [ -z "$target" ] || fail 'status takes no target'; status ;;
    requirements) [ -z "$target" ] || fail 'requirements takes no target'; bash "$SCRIPT_DIR/void-requirements.sh" ;;
    park) [ -z "$target" ] || fail 'park takes no target'; park ;;
    wake) [ -z "$target" ] || fail 'wake takes no target'; wake ;;
    start|stop|enable|disable)
      [ -n "$target" ] || fail "$command requires a target"
      require_known_target "$target"
      confirm "$command $target"
      require_target_units "$target"
      "${command}_target" "$target"
      ;;
    *) fail "Unknown command '$command'. Run with --help." ;;
  esac
}

main "$@"
