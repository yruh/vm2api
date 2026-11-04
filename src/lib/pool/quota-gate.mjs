/**
 * One 5h/7d gate model for admission (AccountQuota), the panel
 * (evaluateAccount) and the seat planner, so a slot the console paints as
 * usable is one the scheduler will actually run.
 *
 *   open      u < limit − band
 *   draining  limit − band ≤ u < limit + overshoot. Seated work keeps running
 *             on this VM one call at a time: the header reading lags calls
 *             already in flight, so a second concurrent call waits on the VM
 *             instead of moving away. New seats land here only when no open
 *             VM can take them.
 *   gated     u ≥ limit + overshoot: the VM leaves the pool until the reading
 *             drops or the window resets.
 *
 * `u` and `limit` are 0–1 ratios. Upstream hard limits (rejected / 100%) are
 * checked separately and always win.
 */

/** Width below the configured line where per-call brakes apply. */
export const DEFAULT_CRITICAL_BAND = 0.05
/** How far past the configured line seated work may run before the VM is left. */
export const DEFAULT_GATE_OVERSHOOT = 0.05
export const GATE_OVERSHOOT_MAX = 0.1

export const GATE_OPEN = 'open'
export const GATE_DRAINING = 'draining'
export const GATE_GATED = 'gated'

export function criticalBandOf(quota = {}) {
  const n = Number(quota?.critical_band)
  if (Number.isFinite(n) && n >= 0 && n <= 0.5) return n
  return DEFAULT_CRITICAL_BAND
}

export function gateOvershootOf(quota = {}) {
  const raw = quota?.gate_overshoot
  if (raw == null || raw === '') return DEFAULT_GATE_OVERSHOOT
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0 && n <= GATE_OVERSHOOT_MAX) return n
  return DEFAULT_GATE_OVERSHOOT
}

/** `{ band, overshoot }` from a `routing.quota` block (or a policy carrying the same keys). */
export function quotaGateOf(quota = {}) {
  return { band: criticalBandOf(quota), overshoot: gateOvershootOf(quota) }
}

/** The 7d line is hard: overrunning it locks the account for days, so no band and no overshoot. */
export const WEEKLY_GATE = Object.freeze({ band: 0, overshoot: 0 })

/** Gate keys to stamp onto a tier policy so evaluateAccount sees the configured band/overshoot. */
export function gatePolicyFields(quota = {}) {
  return { critical_band: criticalBandOf(quota), gate_overshoot: gateOvershootOf(quota) }
}

/** Float slack: 0.8 + 0.05 is 0.8500000000000001, and a reading of exactly 85% must gate. */
const EPSILON = 1e-9

export function gateZone(util, limit, { band = DEFAULT_CRITICAL_BAND, overshoot = DEFAULT_GATE_OVERSHOOT } = {}) {
  const u = Number(util)
  const line = Number(limit)
  if (!(line > 0) || !(u > 0)) return GATE_OPEN
  if (u + EPSILON >= line + overshoot) return GATE_GATED
  if (u + EPSILON >= line - band) return GATE_DRAINING
  return GATE_OPEN
}

const RANK = { [GATE_OPEN]: 0, [GATE_DRAINING]: 1, [GATE_GATED]: 2 }

/** The stricter of two zones. */
export function worstGateZone(a, b) {
  return (RANK[b] || 0) > (RANK[a] || 0) ? b : a
}
