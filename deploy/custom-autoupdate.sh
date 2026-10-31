#!/usr/bin/env bash
# Fork-only (yruh/vm2api): keep this install on the newest release of the fork.
# Installed by hand as /opt/vm2api/custom/autoupdate.sh with a cron entry:
#   */20 * * * * root /opt/vm2api/custom/autoupdate.sh >>/var/log/vm2api-autoupdate.log 2>&1
#
# Upgrades with the stock deploy/install.sh (VM2API_GITHUB_REPO + VM2API_IMAGE
# point it at the fork), only after IDLE_MINUTES without traffic or once an
# update has waited MAX_DEFER_HOURS. A failed upgrade or health check rolls
# back to the previous repo/image/tag. install.sh never deletes old
# control-plane images (~860 MB each), so this keeps at most the running one
# and the one before it.
set -uo pipefail

REPO="${CUSTOM_REPO:-yruh/vm2api}"
DIR="${VM2API_DIR:-/opt/vm2api}"
IDLE_MINUTES="${IDLE_MINUTES:-10}"
MAX_DEFER_HOURS="${MAX_DEFER_HOURS:-12}"
UPSTREAM_REPO="dofastted/vm2api"
UPSTREAM_IMAGE="ghcr.io/dofastted/vm2api"
OWNER="$(printf '%s' "${REPO%%/*}" | tr '[:upper:]' '[:lower:]')"
IMAGE="ghcr.io/${OWNER}/vm2api"
STATE_DIR="${DIR}/custom"
PENDING="${STATE_DIR}/pending-since"

log() { echo "$(date -u +%FT%TZ) $*"; }

exec 9>/run/vm2api-autoupdate.lock
flock -n 9 || exit 0
mkdir -p "$STATE_DIR"

env_get() { grep -E "^$1=" "${DIR}/.env" 2>/dev/null | tail -n1 | cut -d= -f2-; }
env_set() {
  if grep -qE "^$1=" "${DIR}/.env"; then
    sed -i "s|^$1=.*|$1=$2|" "${DIR}/.env"
  else
    printf '%s=%s\n' "$1" "$2" >>"${DIR}/.env"
  fi
}

latest="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${REPO}/releases/latest" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"])' 2>/dev/null)"
if ! [[ "$latest" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log "cannot read latest release of ${REPO}"
  exit 0
fi
current="v$(tr -d '[:space:]' <"${DIR}/VERSION")"
current_image="$(env_get VM2API_IMAGE)"
current_image="${current_image:-$UPSTREAM_IMAGE}"
if [ "$latest" = "$current" ] && [ "$current_image" = "$IMAGE" ]; then
  rm -f "$PENDING"
  exit 0
fi
if [ "$latest" = "$(cat "${STATE_DIR}/failed-tag" 2>/dev/null)" ]; then
  exit 0
fi

now="$(date +%s)"
[ -f "$PENDING" ] || echo "$now" >"$PENDING"
waited_h=$(((now - $(cat "$PENDING")) / 3600))
idle_min="$(python3 - "${DIR}/data/kin.db" <<'PY' 2>/dev/null
import sqlite3, sys
from datetime import datetime, timezone
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
row = c.execute("select max(created_at) from usage_logs").fetchone()
if not row or not row[0]:
    print(10**6)
else:
    last = datetime.fromisoformat(row[0].replace("Z", "+00:00"))
    print(int((datetime.now(timezone.utc) - last).total_seconds() // 60))
PY
)"
idle_min="${idle_min:-0}"
if [ "$idle_min" -lt "$IDLE_MINUTES" ] && [ "$waited_h" -lt "$MAX_DEFER_HOURS" ]; then
  log "update ${current} -> ${latest} waiting: last request ${idle_min} min ago (deferred ${waited_h}h)"
  exit 0
fi

prev_repo="$UPSTREAM_REPO"
[ "$current_image" = "$IMAGE" ] && prev_repo="$REPO"

# Remove control-plane images (upstream's and this fork's) except the given refs.
prune_images() {
  local ref keep
  docker images --format '{{.Repository}}:{{.Tag}}' |
    grep -E "^ghcr\.io/(dofastted|${OWNER})/vm2api:" |
    while read -r ref; do
      for keep in "$@"; do
        [ "$ref" = "$keep" ] && continue 2
      done
      docker rmi "$ref" >/dev/null 2>&1 && log "removed old image ${ref}"
    done
  docker image prune -f >/dev/null 2>&1 || true
}

healthy() {
  local port i
  port="$(env_get PORT)"
  port="${port:-8787}"
  for i in $(seq 1 60); do
    if curl -fsS --noproxy '*' --max-time 5 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      [ "v$(tr -d '[:space:]' <"${DIR}/VERSION")" = "$1" ] &&
        docker inspect vm2api --format '{{.Config.Image}}' 2>/dev/null | grep -q "^$2:" &&
        return 0
    fi
    sleep 5
  done
  return 1
}

running_image="$(docker inspect vm2api --format '{{.Config.Image}}' 2>/dev/null || true)"
prune_images "$running_image" "${IMAGE}:${latest}"

log "upgrading ${current} (${current_image}) -> ${latest} (${IMAGE})"
env_set VM2API_IMAGE "$IMAGE"
if VM2API_GITHUB_REPO="$REPO" bash "${DIR}/deploy/install.sh" upgrade --yes --version "$latest" &&
  healthy "$latest" "$IMAGE"; then
  rm -f "$PENDING"
  echo "$latest" >"${STATE_DIR}/last-good"
  log "upgrade to ${latest} done"
  prune_images "${IMAGE}:${latest}" "$running_image"
  exit 0
fi

log "upgrade to ${latest} failed; rolling back to ${current} from ${prev_repo}"
env_set VM2API_IMAGE "$current_image"
if VM2API_GITHUB_REPO="$prev_repo" bash "${DIR}/deploy/install.sh" upgrade --yes --version "$current" &&
  healthy "$current" "$current_image"; then
  log "rollback to ${current} done"
else
  log "ROLLBACK FAILED: check docker logs vm2api"
fi
# Do not retry the same broken tag every run; a newer release (or deleting
# custom/failed-tag) retries.
echo "$latest" >"${STATE_DIR}/failed-tag"
rm -f "$PENDING"
exit 1
