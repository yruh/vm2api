/**
 * Fork-local (yruh/vm2api): a new seat goes to the account whose 7d window
 * resets first, so budget that would expire unused at that reset is spent
 * before longer-lived budget elsewhere. Priority still comes first; resets
 * within `tie_minutes` of each other, and accounts with no known reset, keep
 * the upstream order (occupancy, headroom, vmId). Seated sessions never move.
 */
import { listQuotaFromHeaders, parseResetMs } from '../pool/quota-window.mjs'
import { customConfig } from './session-cache.mjs'

function weeklyResetMs(candidate, now) {
  const unified = candidate?.account?.unified
  if (!unified) return Number.POSITIVE_INFINITY
  const ms = parseResetMs(listQuotaFromHeaders(unified, { now })['7d']?.reset)
  return Number.isFinite(ms) && ms > now ? ms : Number.POSITIVE_INFINITY
}

function compare(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function tieMs(cfg) {
  return Math.max(1, Number(cfg.tie_minutes) || 0) * 60_000
}

function resetBucket(candidate, cfg, now) {
  const ms = weeklyResetMs(candidate, now)
  return Number.isFinite(ms) ? Math.floor(ms / tieMs(cfg)) : ms
}

/**
 * Whether `candidate` should be preferred over `other`: higher priority, or
 * a 7d reset more than `tie_minutes` earlier. Stricter than the bucketed
 * sort, so two resets a few minutes apart never trade places.
 */
export function outranksByWeeklyReset(candidate, other, { config = customConfig, now = Date.now() } = {}) {
  const cfg = config().weekly_reset_first
  if (!cfg?.enabled || !candidate || !other) return false
  const priority = (Number(candidate.priority) || 0) - (Number(other.priority) || 0)
  if (priority) return priority > 0
  const mine = weeklyResetMs(candidate, now)
  if (!Number.isFinite(mine)) return false
  return weeklyResetMs(other, now) - mine > tieMs(cfg)
}

/** Re-sort an upstream seat ranking; returns it unchanged when disabled. */
export function weeklyResetFirst(ranked, { config = customConfig, now = Date.now() } = {}) {
  const cfg = config().weekly_reset_first
  if (!cfg?.enabled || ranked.length < 2) return ranked
  return ranked
    .map((candidate, index) => ({ candidate, index, bucket: resetBucket(candidate, cfg, now) }))
    .sort(
      (left, right) =>
        (Number(right.candidate.priority) || 0) - (Number(left.candidate.priority) || 0) ||
        compare(left.bucket, right.bucket) ||
        left.index - right.index,
    )
    .map((entry) => entry.candidate)
}
