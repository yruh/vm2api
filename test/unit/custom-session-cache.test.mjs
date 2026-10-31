import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Defaults only: no custom.json next to the test process.
process.env.KIN_CUSTOM_FILE = path.join(os.tmpdir(), `kin-custom-missing-${process.pid}.json`)

const { FailoverRunner } = await import('../../src/lib/pool/failover-runner.mjs')
const { StickyRouter } = await import('../../src/lib/pool/sticky-router.mjs')
const { isCompactionRequest, mergeCustomConfig, SessionCachePolicy } = await import(
  '../../src/lib/custom/session-cache.mjs'
)

const HOME = { accountId: 'account-4', vmId: 'vm-04' }
const OTHER = { accountId: 'account-1', vmId: 'vm-01' }
const COMPACT_TEXT = 'Your task is to create a detailed summary of the conversation so far, paying close attention'

function success() {
  return {
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

function bigBody(lastUser = 'next step') {
  return {
    model: 'claude-opus-test',
    messages: [
      { role: 'user', content: 'x'.repeat(400_000) },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: [{ type: 'text', text: lastUser }] },
    ],
  }
}

function setup(t, name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kin-custom-${name}-`))
  const sticky = new StickyRouter({ dataDir, config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const stickyKey = sticky.canonicalSessionKey(`caller-${name}`)
  sticky.bind(stickyKey, { ...HOME, sessionId: 'home-session' }, { countHit: false })
  return { sticky, stickyKey }
}

function scheduler({ selectionReason = 'balanced', home = { draining: true, headroom: 0.02 } } = {}) {
  const calls = { select: [], released: 0 }
  return {
    calls,
    async eligibleCandidates({ onlyVmIds = null, excluded = new Set() } = {}) {
      const all = [
        { ...HOME, ...home },
        { ...OTHER, draining: false, headroom: 0.9 },
      ]
      return all.filter(
        (c) => (!onlyVmIds || onlyVmIds.has(c.vmId)) && !excluded.has(c.vmId) && !excluded.has(c.accountId),
      )
    },
    async selectAndReserve({ excluded = new Set() } = {}) {
      calls.select.push(new Set(excluded))
      const unit = excluded.has(OTHER.vmId) ? HOME : OTHER
      const reason = unit === HOME ? 'device-affinity' : selectionReason
      return { ok: true, ...unit, selectionReason: reason, release: () => calls.released++ }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
}

function attemptMeta(body, selected) {
  return { body, meta: { sessionId: `${selected.vmId}-session` } }
}

test('a balanced move off the pinned VM re-pins the session where it was served', async (t) => {
  const { sticky, stickyKey } = setup(t, 'follow')
  const sched = scheduler()
  const runner = new FailoverRunner({ scheduler: sched, stickyRouter: sticky })
  const result = await runner.run({
    requestId: 'follow',
    canonicalBody: { model: 'claude-opus-test', messages: [{ role: 'user', content: 'hi' }] },
    model: 'claude-opus-test',
    stickyKey,
    applyAttempt: attemptMeta,
    callAttempt: () => success(),
  })
  assert.equal(result.ok, true)
  const pin = sticky.resolve(stickyKey)
  assert.equal(pin.vmId, 'vm-01')
  assert.equal(pin.accountId, 'account-1')
  assert.equal(pin.sessionId, 'vm-01-session')
})

test('a capacity spill keeps the session pinned at home', async (t) => {
  const { sticky, stickyKey } = setup(t, 'spill')
  const runner = new FailoverRunner({ scheduler: scheduler({ selectionReason: 'sticky-spill' }), stickyRouter: sticky })
  await runner.run({
    requestId: 'spill',
    canonicalBody: { model: 'claude-opus-test', messages: [{ role: 'user', content: 'hi' }] },
    model: 'claude-opus-test',
    stickyKey,
    applyAttempt: attemptMeta,
    callAttempt: () => success(),
  })
  assert.equal(sticky.resolve(stickyKey).vmId, 'vm-04')
})

test('a large session leaving a draining home gets prompt-too-long once, then proceeds', async (t) => {
  const { sticky, stickyKey } = setup(t, 'force')
  const sched = scheduler()
  const runner = new FailoverRunner({ scheduler: sched, stickyRouter: sticky })
  let calls = 0
  const run = () =>
    runner.run({
      requestId: `force-${calls}`,
      canonicalBody: bigBody(),
      model: 'claude-opus-test',
      stickyKey,
      applyAttempt: attemptMeta,
      callAttempt: () => {
        calls++
        return success()
      },
    })
  const first = await run()
  assert.equal(first.status, 400)
  assert.match(first.body.error.message, /^prompt is too long: \d+ tokens > \d+ maximum$/)
  assert.equal(calls, 0)
  assert.equal(sched.calls.released, 1)
  assert.equal(sticky.resolve(stickyKey).vmId, 'vm-04')
  const second = await run()
  assert.equal(second.ok, true)
  assert.equal(calls, 1)
})

test('a healthy home is left without forcing compaction', async (t) => {
  const { sticky, stickyKey } = setup(t, 'healthy')
  const runner = new FailoverRunner({
    scheduler: scheduler({ home: { draining: false, headroom: 0.5 } }),
    stickyRouter: sticky,
  })
  const result = await runner.run({
    requestId: 'healthy',
    canonicalBody: bigBody(),
    model: 'claude-opus-test',
    stickyKey,
    applyAttempt: attemptMeta,
    callAttempt: () => success(),
  })
  assert.equal(result.ok, true)
})

test('the compaction turn goes back to the warm home VM', async (t) => {
  const { sticky, stickyKey } = setup(t, 'compact')
  const sched = scheduler()
  const runner = new FailoverRunner({ scheduler: sched, stickyRouter: sticky })
  let servedOn = null
  const result = await runner.run({
    requestId: 'compact',
    canonicalBody: bigBody(COMPACT_TEXT),
    model: 'claude-opus-test',
    stickyKey,
    applyAttempt: attemptMeta,
    callAttempt: ({ candidate }) => {
      servedOn = candidate.vmId
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(servedOn, 'vm-04')
  assert.ok(sched.calls.select[0].has('vm-01'))
  assert.equal(sticky.resolve(stickyKey).vmId, 'vm-04')
})

test('a large session staying on its draining home is compacted there, small ones are not', async () => {
  const policy = new SessionCachePolicy()
  const args = (stickyKey, body) => ({
    scheduler: scheduler(),
    stickyRouter: { resolve: () => HOME },
    stickyKey,
    selected: { ...HOME, selectionReason: 'sticky' },
    body,
    selectArgs: {},
  })
  const forced = await policy.forceCompaction(args('sess:stay', bigBody()))
  assert.equal(forced.status, 400)
  assert.equal(forced.body.error.details.reason, 'home_draining')
  assert.equal(await policy.forceCompaction(args('sess:stay', bigBody())), null)
  assert.equal(await policy.forceCompaction(args('sess:small', { messages: [{ role: 'user', content: 'hi' }] })), null)
  assert.equal(await policy.forceCompaction(args('sess:compact', bigBody(COMPACT_TEXT))), null)
  const healthy = await policy.forceCompaction({
    ...args('sess:healthy', bigBody()),
    scheduler: scheduler({ home: { draining: false, headroom: 0.5 } }),
  })
  assert.equal(healthy, null)
})

test('disabled config changes nothing', async () => {
  const policy = new SessionCachePolicy({
    config: () => mergeCustomConfig({ follow: { enabled: false }, force_compact: { enabled: false } }),
  })
  const forced = await policy.forceCompaction({
    scheduler: scheduler(),
    stickyRouter: { resolve: () => HOME },
    stickyKey: 'sess:x',
    selected: { ...OTHER, selectionReason: 'balanced' },
    body: bigBody(),
    selectArgs: {},
  })
  assert.equal(forced, null)
  assert.equal(
    policy.follow({ stickyRouter: { resolve: () => HOME }, selected: { ...OTHER, selectionReason: 'balanced' } }),
    false,
  )
})

test('compaction requests are recognised by the summary instruction', () => {
  assert.equal(isCompactionRequest(bigBody(COMPACT_TEXT)), true)
  assert.equal(isCompactionRequest({ messages: [{ role: 'user', content: COMPACT_TEXT }] }), true)
  assert.equal(isCompactionRequest(bigBody()), false)
  assert.equal(isCompactionRequest({}), false)
})
