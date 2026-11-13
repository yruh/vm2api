# yruh/vm2api — custom fork

Upstream: [dofastted/vm2api](https://github.com/dofastted/vm2api). Branch `custom` = newest
upstream release + the commits below. `.github/workflows/custom-sync.yml` rebases them onto
each new upstream release (once it is 2 h old), tests, publishes `ghcr.io/yruh/vm2api:<tag>`
and a release here. A conflict or regression opens an issue and publishes nothing; the
server stays on the last good release.

## Patches

`src/lib/custom/session-cache.mjs`, called from four spots in `src/lib/pool/failover-runner.mjs`:

- **follow**: a session moved off its pinned VM by a strategy pick (balanced / fill /
  priority-load) or a device / family affinity re-pins where it was served, so it does not
  bounce back to an expired cache when the old VM's window resets, its compaction turn goes
  to the warm VM, and its outbound session stays the same from turn to turn.
- **force_compact**: the last `reserve_headroom` (3%) of every account's 5h/7d budget is kept
  for compaction turns. Once an account is down to it, other requests stop going there
  (they move to another account, or fail when none is left), and a large session pinned
  there gets `prompt is too long: N tokens > M maximum` once; Claude Code compacts. The
  compaction request goes back to the warm home VM and is paid from the reserve.
  Claude Code answers that error with a compaction that keeps the running turn verbatim, so
  mid-turn (the request carries tool results) an Anthropic client gets a 200 assistant reply
  opening with `[vm2api:compact]` instead: the turn ends, and the `cc-compact-on-pause` mod
  (or the person) runs `/compact`, which summarizes everything. A session is forced at most
  once per home within `once_per_home_ms`, and not at all on a home it already compacted on
  inside the reserve (forced, manual or the client's own).
- **rehome_after_compact**: after a compaction turn (auto, forced or manual `/compact`), if an
  account that `weekly_reset_first` prefers (higher priority, or 7d reset more than
  `tie_minutes` earlier) is not draining and has at least `min_headroom` budget left, the
  session and its device are re-pinned there with a fresh outbound session. The next turn
  starts on it; only the short summary is written to a cold cache.

`src/lib/custom/seat-order.mjs`, called from `SeatPlanner.rank` in `src/lib/pool/seat-planner.mjs`:

- **weekly_reset_first**: a new session goes to the account whose 7d window resets first
  (after priority), so budget that would expire at that reset is used before longer-lived
  budget. Resets within `tie_minutes` keep the upstream order (occupancy, headroom).
  Running sessions stay where they are.

Config: `src/config/custom.json` (host-mounted, the panel never writes it), all optional:

```json
{
  "follow": { "enabled": true },
  "force_compact": {
    "enabled": true,
    "min_prompt_tokens": 100000,
    "reserve_headroom": 0.03,
    "once_per_home_ms": 18000000,
    "home_wait_ms": 20000
  },
  "weekly_reset_first": { "enabled": true, "tie_minutes": 60 },
  "rehome_after_compact": { "enabled": true, "min_headroom": 0.5 }
}
```

Draining starts at `limit − routing.quota.critical_band`; set `critical_band` to the point
where sessions should start leaving (0.03 → 97% with limit 1). `routing.pool.seat_budget_reserve_pct`
0 lets a VM take new seats up to 100%.

## Server

`deploy/custom-autoupdate.sh` → `/opt/vm2api/custom/autoupdate.sh`, cron every 20 min. It
upgrades with the stock `deploy/install.sh` pointed at this fork, waits for 10 idle minutes
(at most 12 h), checks `/health`, and rolls back on failure. Log: `/var/log/vm2api-autoupdate.log`.

## When sync fails

Rebase `custom` onto the new upstream tag by hand, fix the conflict, push, then close the
issue or run the workflow with `force`.
