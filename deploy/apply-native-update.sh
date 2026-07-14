#!/bin/sh
set -eu
umask 077

ROOT_DIR=${AGAPORNIS_ROOT_DIR:-/opt/agapornis}
STATE_DIR=${AGAPORNIS_STATE_DIR:-/var/lib/agapornis}
API_ROOT_DIR=${AGAPORNIS_API_ROOT_DIR:-$ROOT_DIR/api}
FRONTEND_ROOT_DIR=${AGAPORNIS_FRONTEND_ROOT_DIR:-$ROOT_DIR/frontend}
API_STATE_DIR=${AGAPORNIS_API_STATE_DIR:-$STATE_DIR/api}
FRONTEND_STATE_DIR=${AGAPORNIS_FRONTEND_STATE_DIR:-$STATE_DIR/frontend}
UPDATE_ROOT=${AGAPORNIS_PANEL_UPDATE_DIR:-$API_STATE_DIR/panel-updates}
JOB_FILE=${1:-${AGAPORNIS_UPDATE_JOB:-$UPDATE_ROOT/current-job.json}}
API_PORT=${PORT:-3001}
API_HEALTH_URL=${AGAPORNIS_API_HEALTH_URL:-http://127.0.0.1:$API_PORT/api/system/health}
FRONTEND_HEALTH_URL=${AGAPORNIS_FRONTEND_HEALTH_URL:-http://127.0.0.1:3000/}
HEALTH_ATTEMPTS=${AGAPORNIS_UPDATE_HEALTH_ATTEMPTS:-30}
SERVICE_USER=${AGAPORNIS_SERVICE_USER:-agapornis}
API_NPM_CACHE_DIR=${AGAPORNIS_API_NPM_CACHE_DIR:-${AGAPORNIS_NPM_CACHE_DIR:-$API_STATE_DIR/.npm-cache}}
FRONTEND_NPM_CACHE_DIR=${AGAPORNIS_FRONTEND_NPM_CACHE_DIR:-${AGAPORNIS_NPM_CACHE_DIR:-$FRONTEND_STATE_DIR/.npm-cache}}

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
[ -f "$JOB_FILE" ] || { echo "update job is missing: $JOB_FILE" >&2; exit 1; }
[ "$(jq -r '.schemaVersion // 0' "$JOB_FILE")" = 1 ] || { echo "unsupported update job schema" >&2; exit 1; }

staging=$(jq -r '.stagingDirectory // empty' "$JOB_FILE")
result_file=$(jq -r '.resultFile // empty' "$JOB_FILE")
api_version=$(jq -r '.updates.api.version // empty' "$JOB_FILE")
api_artifact=$(jq -r '.updates.api.artifactPath // empty' "$JOB_FILE")
frontend_version=$(jq -r '.updates.frontend.version // empty' "$JOB_FILE")
frontend_artifact=$(jq -r '.updates.frontend.artifactPath // empty' "$JOB_FILE")

case "$staging" in "$UPDATE_ROOT"/*) ;; *) echo "staging directory is outside the update root" >&2; exit 1;; esac
case "$result_file" in "$UPDATE_ROOT"/*) ;; *) echo "result file is outside the update root" >&2; exit 1;; esac

validate_component() {
  name=$1
  version=$2
  artifact=$3
  [ -n "$version" ] || { [ -z "$artifact" ] || { echo "$name artifact has no version" >&2; exit 1; }; return 0; }
  printf '%s' "$version" | grep -Eq '^[0-9][0-9A-Za-z._-]{0,63}$' || { echo "invalid $name version" >&2; exit 1; }
  case "$artifact" in "$staging"/*) ;; *) echo "$name artifact is outside the staging directory" >&2; exit 1;; esac
  [ -f "$artifact" ] || { echo "$name artifact is missing" >&2; exit 1; }
}

target_versions=$(jq -c '.updates | with_entries(.value = .value.version)' "$JOB_FILE")
old_api=$(readlink -f "$API_ROOT_DIR/current" 2>/dev/null || true)
old_frontend=$(readlink -f "$FRONTEND_ROOT_DIR/current" 2>/dev/null || true)
api_version_backup="$staging/api-version.env.previous"
frontend_version_backup="$staging/frontend-version.env.previous"
activated=0
completed=0
error_message="native update command failed"

write_result() {
  status=$1
  message=${2:-}
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  temporary="$result_file.tmp"
  if [ "$status" = completed ]; then
    jq -n --arg status "$status" --arg completedAt "$timestamp" --argjson targetVersions "$target_versions" \
      '{status:$status,completedAt:$completedAt,targetVersions:$targetVersions}' > "$temporary"
  else
    jq -n --arg status "$status" --arg failedAt "$timestamp" --arg errorMessage "$message" --argjson targetVersions "$target_versions" \
      '{status:$status,failedAt:$failedAt,errorMessage:$errorMessage,targetVersions:$targetVersions}' > "$temporary"
  fi
  mv "$temporary" "$result_file"
  if chown "$SERVICE_USER:$SERVICE_USER" "$result_file" 2>/dev/null; then chmod 0600 "$result_file"; else chmod 0644 "$result_file"; fi
}

restore_link() {
  root=$1
  previous=$2
  if [ -n "$previous" ]; then
    ln -sfn "$previous" "$root/current.rollback"
    mv -Tf "$root/current.rollback" "$root/current"
  else
    rm -f "$root/current"
  fi
}

restore_version_file() {
  target=$1
  backup=$2
  if [ -f "$backup" ]; then cp "$backup" "$target"; else rm -f "$target"; fi
}

rollback() {
  [ "$activated" = 1 ] || return 0
  [ -z "$api_version" ] || {
    restore_link "$API_ROOT_DIR" "$old_api"
    restore_version_file "$API_STATE_DIR/version.env" "$api_version_backup"
  }
  [ -z "$frontend_version" ] || {
    restore_link "$FRONTEND_ROOT_DIR" "$old_frontend"
    restore_version_file "$FRONTEND_STATE_DIR/version.env" "$frontend_version_backup"
  }
  systemctl daemon-reload
  [ -z "$api_version" ] || systemctl restart agapornis-api.service || true
  [ -z "$frontend_version" ] || systemctl restart agapornis-frontend.service || true
}

finish() {
  code=$?
  if [ "$completed" = 1 ]; then return 0; fi
  trap - EXIT INT TERM HUP
  [ "$code" -ne 0 ] || code=1
  set +e
  rollback
  write_result failed "$error_message"
  exit "$code"
}
trap finish EXIT INT TERM HUP

command -v runuser >/dev/null 2>&1 || { error_message="runuser is required"; exit 1; }
command -v curl >/dev/null 2>&1 || { error_message="curl is required"; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || { error_message="service user does not exist: $SERVICE_USER"; exit 1; }
validate_component api "$api_version" "$api_artifact"
validate_component frontend "$frontend_version" "$frontend_artifact"
[ -n "$api_version$frontend_version" ] || { error_message="update job has no components"; exit 1; }
[ ! -f "$API_STATE_DIR/version.env" ] || cp "$API_STATE_DIR/version.env" "$api_version_backup"
[ ! -f "$FRONTEND_STATE_DIR/version.env" ] || cp "$FRONTEND_STATE_DIR/version.env" "$frontend_version_backup"

prepare_api() {
  release="$API_ROOT_DIR/releases/$api_version"
  [ ! -e "$release" ] || { [ -f "$release/dist/main.js" ] && return 0; echo "existing API release is incomplete" >&2; exit 1; }
  build="$API_ROOT_DIR/releases/.${api_version}.building.$$"
  mkdir -p "$build"
  chown "$SERVICE_USER:$SERVICE_USER" "$build"
  runuser -u "$SERVICE_USER" -- tar -xzf "$api_artifact" -C "$build"
  runuser -u "$SERVICE_USER" -- env HOME="$API_STATE_DIR" npm_config_cache="$API_NPM_CACHE_DIR" \
    sh -c 'cd "$1" && npm ci && npx tsc && npm prune --omit=dev' sh "$build"
  ln -s "$API_STATE_DIR/data" "$build/data"
  mv "$build" "$release"
}

prepare_frontend() {
  release="$FRONTEND_ROOT_DIR/releases/$frontend_version"
  [ ! -e "$release" ] || { [ -f "$release/.next/BUILD_ID" ] && return 0; echo "existing frontend release is incomplete" >&2; exit 1; }
  build="$FRONTEND_ROOT_DIR/releases/.${frontend_version}.building.$$"
  mkdir -p "$build"
  chown "$SERVICE_USER:$SERVICE_USER" "$build"
  runuser -u "$SERVICE_USER" -- tar -xzf "$frontend_artifact" -C "$build"
  runuser -u "$SERVICE_USER" -- env \
    HOME="$FRONTEND_STATE_DIR" \
    npm_config_cache="$FRONTEND_NPM_CACHE_DIR" \
    AGAPORNIS_API_URL="${AGAPORNIS_API_URL:-http://127.0.0.1:3001/api}" \
    AGAPORNIS_FRONTEND_VERSION="$frontend_version" \
    sh -c 'cd "$1" && npm ci && npm run build && npm prune --omit=dev' sh "$build"
  mv "$build" "$release"
}

wait_healthy() {
  name=$1
  url=$2
  attempt=0
  while [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then return 0; fi
    attempt=$((attempt + 1))
    sleep 2
  done
  error_message="$name failed its post-update health check"
  return 1
}

[ -z "$api_version" ] || mkdir -p "$API_ROOT_DIR/releases" "$API_STATE_DIR" "$API_NPM_CACHE_DIR"
[ -z "$frontend_version" ] || mkdir -p "$FRONTEND_ROOT_DIR/releases" "$FRONTEND_STATE_DIR" "$FRONTEND_NPM_CACHE_DIR"
[ -z "$api_version" ] || chown "$SERVICE_USER:$SERVICE_USER" "$API_STATE_DIR" "$API_NPM_CACHE_DIR"
[ -z "$frontend_version" ] || chown "$SERVICE_USER:$SERVICE_USER" "$FRONTEND_STATE_DIR" "$FRONTEND_NPM_CACHE_DIR"
[ -z "$api_version" ] || prepare_api
[ -z "$frontend_version" ] || prepare_frontend

[ -z "$api_version" ] || {
  ln -sfn "$API_ROOT_DIR/releases/$api_version" "$API_ROOT_DIR/current.next"
  mv -Tf "$API_ROOT_DIR/current.next" "$API_ROOT_DIR/current"
  printf 'AGAPORNIS_API_VERSION="%s"\n' "$api_version" > "$API_STATE_DIR/version.env.next"
  mv "$API_STATE_DIR/version.env.next" "$API_STATE_DIR/version.env"
}
[ -z "$frontend_version" ] || {
  ln -sfn "$FRONTEND_ROOT_DIR/releases/$frontend_version" "$FRONTEND_ROOT_DIR/current.next"
  mv -Tf "$FRONTEND_ROOT_DIR/current.next" "$FRONTEND_ROOT_DIR/current"
  printf 'AGAPORNIS_FRONTEND_VERSION="%s"\n' "$frontend_version" > "$FRONTEND_STATE_DIR/version.env.next"
  mv "$FRONTEND_STATE_DIR/version.env.next" "$FRONTEND_STATE_DIR/version.env"
}
activated=1
systemctl daemon-reload

[ -z "$api_version" ] || { systemctl restart agapornis-api.service; wait_healthy API "$API_HEALTH_URL"; }
[ -z "$frontend_version" ] || { systemctl restart agapornis-frontend.service; wait_healthy frontend "$FRONTEND_HEALTH_URL"; }

write_result completed
completed=1
trap - EXIT INT TERM HUP
printf 'Agapornis native update completed: API=%s frontend=%s\n' "${api_version:-unchanged}" "${frontend_version:-unchanged}"
