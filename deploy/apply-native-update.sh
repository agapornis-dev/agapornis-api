#!/bin/sh
set -eu
umask 077

JOB_FILE=${1:-/var/lib/agapornis/api/panel-updates/current-job.json}
ROOT_DIR=${AGAPORNIS_ROOT_DIR:-/opt/agapornis}
STATE_DIR=${AGAPORNIS_STATE_DIR:-/var/lib/agapornis}
UPDATE_ROOT=${AGAPORNIS_PANEL_UPDATE_DIR:-$STATE_DIR/api/panel-updates}
API_PORT=${PORT:-3001}
API_HEALTH_URL=${AGAPORNIS_API_HEALTH_URL:-http://127.0.0.1:$API_PORT/api/system/health}
FRONTEND_HEALTH_URL=${AGAPORNIS_FRONTEND_HEALTH_URL:-http://127.0.0.1:3000/}
HEALTH_ATTEMPTS=${AGAPORNIS_UPDATE_HEALTH_ATTEMPTS:-30}
SERVICE_USER=${AGAPORNIS_SERVICE_USER:-agapornis}
NPM_CACHE_DIR=${AGAPORNIS_NPM_CACHE_DIR:-$STATE_DIR/api/.npm-cache}

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
old_api=$(readlink -f "$ROOT_DIR/api/current" 2>/dev/null || true)
old_frontend=$(readlink -f "$ROOT_DIR/frontend/current" 2>/dev/null || true)
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
  component=$1
  previous=$2
  if [ -n "$previous" ]; then
    ln -sfn "$previous" "$ROOT_DIR/$component/current.rollback"
    mv -Tf "$ROOT_DIR/$component/current.rollback" "$ROOT_DIR/$component/current"
  else
    rm -f "$ROOT_DIR/$component/current"
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
    restore_link api "$old_api"
    restore_version_file "$STATE_DIR/api/version.env" "$api_version_backup"
  }
  [ -z "$frontend_version" ] || {
    restore_link frontend "$old_frontend"
    restore_version_file "$STATE_DIR/frontend/version.env" "$frontend_version_backup"
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
[ ! -f "$STATE_DIR/api/version.env" ] || cp "$STATE_DIR/api/version.env" "$api_version_backup"
[ ! -f "$STATE_DIR/frontend/version.env" ] || cp "$STATE_DIR/frontend/version.env" "$frontend_version_backup"

prepare_api() {
  release="$ROOT_DIR/api/releases/$api_version"
  [ ! -e "$release" ] || { [ -f "$release/dist/main.js" ] && return 0; echo "existing API release is incomplete" >&2; exit 1; }
  build="$ROOT_DIR/api/releases/.${api_version}.building.$$"
  mkdir -p "$build"
  chown "$SERVICE_USER:$SERVICE_USER" "$build"
  runuser -u "$SERVICE_USER" -- tar -xzf "$api_artifact" -C "$build"
  runuser -u "$SERVICE_USER" -- env HOME="$STATE_DIR/api" npm_config_cache="$NPM_CACHE_DIR" \
    sh -c 'cd "$1" && npm ci && npx tsc && npm prune --omit=dev' sh "$build"
  ln -s "$STATE_DIR/api/data" "$build/data"
  mv "$build" "$release"
}

prepare_frontend() {
  release="$ROOT_DIR/frontend/releases/$frontend_version"
  [ ! -e "$release" ] || { [ -f "$release/.next/BUILD_ID" ] && return 0; echo "existing frontend release is incomplete" >&2; exit 1; }
  build="$ROOT_DIR/frontend/releases/.${frontend_version}.building.$$"
  mkdir -p "$build"
  chown "$SERVICE_USER:$SERVICE_USER" "$build"
  runuser -u "$SERVICE_USER" -- tar -xzf "$frontend_artifact" -C "$build"
  runuser -u "$SERVICE_USER" -- env \
    HOME="$STATE_DIR/api" \
    npm_config_cache="$NPM_CACHE_DIR" \
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

mkdir -p "$ROOT_DIR/api/releases" "$ROOT_DIR/frontend/releases" "$STATE_DIR/api" "$STATE_DIR/frontend" "$NPM_CACHE_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR/api" "$STATE_DIR/frontend" "$NPM_CACHE_DIR"
[ -z "$api_version" ] || prepare_api
[ -z "$frontend_version" ] || prepare_frontend

[ -z "$api_version" ] || {
  ln -sfn "$ROOT_DIR/api/releases/$api_version" "$ROOT_DIR/api/current.next"
  mv -Tf "$ROOT_DIR/api/current.next" "$ROOT_DIR/api/current"
  printf 'AGAPORNIS_API_VERSION="%s"\n' "$api_version" > "$STATE_DIR/api/version.env.next"
  mv "$STATE_DIR/api/version.env.next" "$STATE_DIR/api/version.env"
}
[ -z "$frontend_version" ] || {
  ln -sfn "$ROOT_DIR/frontend/releases/$frontend_version" "$ROOT_DIR/frontend/current.next"
  mv -Tf "$ROOT_DIR/frontend/current.next" "$ROOT_DIR/frontend/current"
  printf 'AGAPORNIS_FRONTEND_VERSION="%s"\n' "$frontend_version" > "$STATE_DIR/frontend/version.env.next"
  mv "$STATE_DIR/frontend/version.env.next" "$STATE_DIR/frontend/version.env"
}
activated=1
systemctl daemon-reload

[ -z "$api_version" ] || { systemctl restart agapornis-api.service; wait_healthy API "$API_HEALTH_URL"; }
[ -z "$frontend_version" ] || { systemctl restart agapornis-frontend.service; wait_healthy frontend "$FRONTEND_HEALTH_URL"; }

write_result completed
completed=1
trap - EXIT INT TERM HUP
printf 'Agapornis native update completed: API=%s frontend=%s\n' "${api_version:-unchanged}" "${frontend_version:-unchanged}"
