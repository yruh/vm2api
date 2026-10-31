import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

process.env.KIN_CUSTOM_FILE = path.join(os.tmpdir(), `kin-custom-missing-${process.pid}.json`)

const { weeklyResetFirst } = await import('../../src/lib/custom/seat-order.mjs')
const { mergeCustomConfig } = await import('../../src/lib/custom/session-cache.mjs')
const { SeatPlanner } = await import('../../src/lib/pool/seat-planner.mjs')

const NOW = Date.parse('2026-10-31T16:00:00Z')
const HOUR = 3_600_000

function slot(vmId, resetInHours, { priority = 0, seatCap = 4, headroom = 0.5 } = {}) {
  const reset = resetInHours == null ? null : String(Math.floor((NOW + resetInHours * HOUR) / 1000))
  const headers = reset ? { '7d': { utilization: 0.5, reset, status: 'allowed' } } : {}
  return { vmId, priority, seatCap, headroom, account: { unified: { headers } } }
}

const ids = (list) => list.map((candidate) => candidate.vmId)

test('the account whose 7d window resets first takes the new seat', () => {
  const ranked = [slot('vm-01', 6 * 24), slot('vm-04', 20), slot('vm-02', 3 * 24)]
  assert.deepEqual(ids(weeklyResetFirst(ranked, { now: NOW })), ['vm-04', 'vm-02', 'vm-01'])
})

test('priority wins, resets within tie_minutes and unknown resets keep the upstream order', () => {
  const ranked = [slot('vm-a', 30), slot('vm-b', 30.5), slot('vm-c', null), slot('vm-d', 100, { priority: 5 })]
  assert.deepEqual(ids(weeklyResetFirst(ranked, { now: NOW })), ['vm-d', 'vm-a', 'vm-b', 'vm-c'])
  const swapped = [slot('vm-b', 30.5), slot('vm-a', 30)]
  assert.deepEqual(ids(weeklyResetFirst(swapped, { now: NOW })), ['vm-b', 'vm-a'])
})

test('disabled keeps the upstream ranking', () => {
  const ranked = [slot('vm-01', 6 * 24), slot('vm-04', 20)]
  const config = () => mergeCustomConfig({ weekly_reset_first: { enabled: false } })
  assert.deepEqual(ids(weeklyResetFirst(ranked, { config, now: NOW })), ['vm-01', 'vm-04'])
})

test('SeatPlanner.rank prefers the earlier 7d reset over lower occupancy', () => {
  const planner = new SeatPlanner()
  planner.open('seat-1', { vmId: 'vm-04', cap: 4 })
  const resetSoon = slot('vm-04', (Date.now() - NOW) / HOUR + 20)
  const resetLate = slot('vm-01', (Date.now() - NOW) / HOUR + 6 * 24)
  assert.deepEqual(ids(planner.rank([resetLate, resetSoon])), ['vm-04', 'vm-01'])
})
