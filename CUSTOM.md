# yruh/vm2api — custom fork

Upstream: [dofastted/vm2api](https://github.com/dofastted/vm2api). Branch `custom` = newest
upstream release + the commits below. `.github/workflows/custom-sync.yml` rebases them onto
each new upstream release (once it is 2 h old), tests, publishes `ghcr.io/yruh/vm2api:<tag>`
and a release here. A conflict or regression opens an issue and publishes nothing; the
server stays on the last good release.

## Patches

`src/lib/custom/session-cache.mjs`, called from three spots in `src/lib/pool/failover-runner.mjs`:

- **follow**: a session moved off its pinned VM by a strategy pick (balanced / fill /
  priority-load) re-pins where it was served, so it does not bounce back to an expired cache
  when the old VM's window resets.
- **force_compact**: once a large session's home VM is draining (or has `trigger_headroom`
  or less budget left), its next turn, whether it stays on the home or moves off it, gets
  `prompt is too long: N tokens > M maximum` once; Claude Code compacts. The compaction
  request goes back to the warm home VM. Smaller sessions keep using the home's last percent.

Config: `src/config/custom.json` (host-mounted, the panel never writes it), all optional:

```json
{
  "follow": { "enabled": true },
  "force_compact": {
    "enabled": true,
    "min_prompt_tokens": 100000,
    "trigger_headroom": 0.03,
    "when_home_unavailable": false,
    "cooldown_ms": 900000,
    "home_wait_ms": 20000
  }
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
