#!/usr/bin/env bash
# Fork sync (yruh/vm2api): move the custom patches onto the newest upstream
# release and test them. Run by .github/workflows/custom-sync.yml from a full
# checkout of the `custom` branch.
#
# The patched tree keeps upstream's VERSION, so `v$(cat VERSION)` is always
# the upstream tag the patches currently sit on. Outputs (GITHUB_OUTPUT):
#   build=true|false   tag=vX.Y.Z   reason=...
set -euo pipefail

UPSTREAM="${UPSTREAM:-dofastted/vm2api}"
REPO="${GITHUB_REPOSITORY:?}"
MIN_AGE_MINUTES="${MIN_AGE_MINUTES:-120}"
FORCE="${FORCE:-false}"
# Unit test files that cover the scheduler paths the patches touch.
TESTS="${CUSTOM_TESTS:-custom-session-cache custom-seat-order failover-runner pool-scheduler seat-planner sticky-router scheduler-fastpath api-scheduler pool-reservation-release-race schedule-eligibility}"

out() { echo "$1" >>"${GITHUB_OUTPUT:-/dev/null}"; }
fail() {
  echo "::error::$1"
  out "reason=$1"
  exit 1
}

release="$(gh api "repos/${UPSTREAM}/releases/latest")"
tag="$(jq -r .tag_name <<<"$release")"
published="$(jq -r .published_at <<<"$release")"
age=$((($(date +%s) - $(date -d "$published" +%s)) / 60))
echo "upstream latest: ${tag}, published ${age} min ago"
out "tag=${tag}"

if [ "$FORCE" != true ]; then
  if gh release view "$tag" -R "$REPO" >/dev/null 2>&1; then
    echo "${tag} already released on ${REPO}"
    out build=false
    exit 0
  fi
  open_issue="$(gh issue list -R "$REPO" --state open --search "in:title \"custom-sync failed for ${tag}\"" \
    --json number -q '.[0].number' 2>/dev/null || true)"
  if [ -n "$open_issue" ]; then
    echo "issue #${open_issue} is open for ${tag}; close it (or run with force) to retry"
    out build=false
    exit 0
  fi
  if [ "$age" -lt "$MIN_AGE_MINUTES" ]; then
    echo "${tag} is younger than ${MIN_AGE_MINUTES} min; waiting for upstream hotfixes"
    out build=false
    exit 0
  fi
fi

git config user.name "custom-sync[bot]"
git config user.email "custom-sync@users.noreply.github.com"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "https://github.com/${UPSTREAM}.git"
git fetch --no-tags --quiet upstream "+refs/tags/*:refs/upstream-tags/*"

old="v$(tr -d '[:space:]' <VERSION)"
git rev-parse -q --verify "refs/upstream-tags/${old}" >/dev/null || fail "current base ${old} is not an upstream tag"
git rev-parse -q --verify "refs/upstream-tags/${tag}" >/dev/null || fail "upstream tag ${tag} not found"

if [ "$old" != "$tag" ]; then
  echo "rebasing patches ${old} -> ${tag}:"
  git log --oneline "refs/upstream-tags/${old}..HEAD"
  if ! git rebase --onto "refs/upstream-tags/${tag}" "refs/upstream-tags/${old}"; then
    git diff --name-only --diff-filter=U | sed 's/^/  conflict: /'
    git rebase --abort || true
    fail "rebase onto ${tag} conflicts; resolve on the custom branch"
  fi
fi
[ "v$(tr -d '[:space:]' <VERSION)" = "$tag" ] || fail "VERSION does not match ${tag} after rebase"

npm ci --no-audit --no-fund --loglevel=error
find src scripts -name '*.mjs' -print0 | xargs -0 -n1 node --check

run_tests() {
  local dir="$1" log="$2"
  shift 2
  local failed=()
  for name in "$@"; do
    local file="${dir}/test/unit/${name}.test.mjs"
    [ -f "$file" ] || continue
    if ! (cd "$dir" && node --test "test/unit/${name}.test.mjs") >"${log}/${name}.log" 2>&1; then
      failed+=("$name")
    fi
  done
  echo "${failed[@]:-}"
}

logs="$(mktemp -d)"
read -ra patched_failed <<<"$(run_tests "$PWD" "$logs" $TESTS)"
if [ "${#patched_failed[@]}" -gt 0 ]; then
  echo "failing on patched tree: ${patched_failed[*]}; checking pristine ${tag}"
  pristine="$(mktemp -d)"
  git worktree add --detach "$pristine" "refs/upstream-tags/${tag}" >/dev/null
  cp -r node_modules "$pristine/"
  mkdir -p "${logs}/pristine"
  read -ra pristine_failed <<<"$(run_tests "$pristine" "${logs}/pristine" "${patched_failed[@]}")"
  regressions=()
  for name in "${patched_failed[@]}"; do
    if [ ! -f "${pristine}/test/unit/${name}.test.mjs" ] || [[ " ${pristine_failed[*]:-} " != *" ${name} "* ]]; then
      regressions+=("$name")
    fi
  done
  git worktree remove --force "$pristine"
  if [ "${#regressions[@]}" -gt 0 ]; then
    for name in "${regressions[@]}"; do
      echo "::group::${name}"
      tail -n 80 "${logs}/${name}.log"
      echo "::endgroup::"
    done
    fail "patched tree breaks: ${regressions[*]}"
  fi
  echo "same files fail on pristine upstream; not a patch regression"
fi

out build=true
echo "patches on ${tag} pass"
