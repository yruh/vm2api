import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Defaults only: no custom.json next to the test process.
process.env.KIN_CUSTOM_FILE = path.join(os.tmpdir(), `kin-custom-missing-${process.pid}.json`)

const { FailoverRunner } = await import('../../src/lib/pool/failover-runner.mjs')
const { StickyRouter } = await import('../../src/lib/pool/sticky-router.mjs')
const { isCompactionRequest, mergeCustomConfig, PAUSE_MARKER, SessionCachePolicy, writeAssistantReply } = await import(
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
  const sched = scheduler({ home: { draining: true, headroom: 0.5 } })
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

test('a device-affinity move off the pinned VM re-pins the session too', async (t) => {
  const { sticky, stickyKey } = setup(t, 'device')
  const runner = new FailoverRunner({
    scheduler: scheduler({ selectionReason: 'device-affinity', home: { draining: true, headroom: 0.5 } }),
    stickyRouter: sticky,
  })
  await runner.run({
    requestId: 'device',
    canonicalBody: { model: 'claude-opus-test', messages: [{ role: 'user', content: 'hi' }] },
    model: 'claude-opus-test',
    stickyKey,
    applyAttempt: attemptMeta,
    callAttempt: () => success(),
  })
  const pin = sticky.resolve(stickyKey)
  assert.equal(pin.vmId, 'vm-01')
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

test('a large session whose home is down to the reserve is told to compact until it does; side requests do not move it', async (t) => {
  const { sticky, stickyKey } = setup(t, 'force')
  const sched = scheduler()
  const runner = new FailoverRunner({ scheduler: sched, stickyRouter: sticky })
  let calls = 0
  let servedOn = null
  const run = (body = bigBody()) =>
    runner.run({
      requestId: `force-${calls}`,
      canonicalBody: body,
      model: 'claude-opus-test',
      stickyKey,
      applyAttempt: attemptMeta,
      callAttempt: ({ candidate }) => {
        calls++
        servedOn = candidate.vmId
        return success()
      },
    })
  const first = await run()
  assert.equal(first.status, 400)
  assert.match(first.body.error.message, /^prompt is too long: \d+ tokens > \d+ maximum$/)
  assert.equal(first.body.error.details.reason, 'home_in_compaction_reserve')
  assert.equal(calls, 0)
  assert.equal(sched.calls.select.length, 0)
  assert.equal(sticky.resolve(stickyKey).vmId, 'vm-04')
  assert.equal((await run()).status, 400)
  assert.equal(calls, 0)
  // A subagent / title request of the same session borrows another account.
  const side = await run({ model: 'claude-opus-test', messages: [{ role: 'user', content: 'title?' }] })
  assert.equal(side.ok, true)
  assert.equal(servedOn, 'vm-01')
  assert.ok(sched.calls.select[0].has('vm-04'))
  assert.equal(sticky.resolve(stickyKey).vmId, 'vm-04')
  // The compaction turn then still lands on the warm home.
  servedOn = null
  const compact = await run(bigBody(COMPACT_TEXT))
  assert.equal(compact.ok, true)
  assert.equal(servedOn, 'vm-04')
  // Compacted inside the reserve: the session is free to move on.
  const after = await run()
  assert.equal(after.ok, true)
  assert.equal(servedOn, 'vm-01')
  assert.equal(sticky.resolve(stickyKey).vmId, 'vm-01')
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

test('the compaction turn goes back to the warm home VM and may spend its reserve', async (t) => {
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

function reserveArgs(stickyKey, body, { headroom = 0.02, home = HOME } = {}) {
  return {
    scheduler: scheduler({ home: { draining: false, headroom } }),
    stickyRouter: { resolve: () => home },
    stickyKey,
    body,
    selectArgs: { excluded: new Set() },
  }
}

test('the reserve starts at 3% left: 96% runs on, 97% forces a large session', async () => {
  const policy = new SessionCachePolicy()
  const open = reserveArgs('sess:96', bigBody(), { headroom: 1 - 0.96 })
  assert.equal(await policy.compactionReserve(open), null)
  assert.equal(open.selectArgs.excluded.size, 0)
  const forced = await policy.compactionReserve(reserveArgs('sess:97', bigBody(), { headroom: 1 - 0.97 }))
  assert.equal(forced.status, 400)
  assert.equal(forced.body.error.details.reason, 'home_in_compaction_reserve')
  assert.equal(forced.customReply, undefined)
})

test('inside the reserve small sessions are kept off the account, compaction turns are not', async () => {
  const policy = new SessionCachePolicy()
  const small = reserveArgs('sess:small', { messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(await policy.compactionReserve(small), null)
  assert.ok(small.selectArgs.excluded.has('vm-04') && small.selectArgs.excluded.has('account-4'))
  assert.ok(!small.selectArgs.excluded.has('vm-01'))
  const compact = reserveArgs('sess:compact', bigBody(COMPACT_TEXT))
  assert.equal(await policy.compactionReserve(compact), null)
  assert.equal(compact.selectArgs.excluded.size, 0)
})

test('a session is forced on every large turn until it compacts; on its next home it is forced again', async () => {
  const policy = new SessionCachePolicy()
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    assert.equal((await policy.compactionReserve(reserveArgs('sess:burn', bigBody()))).status, 400)
    now += 60 * 60 * 1000
    assert.equal((await policy.compactionReserve(reserveArgs('sess:burn', bigBody()))).status, 400)
    assert.ok(policy.holdsHome('sess:burn', { resolve: () => HOME }))
    policy.noteCompaction('sess:burn', 'vm-04', true)
    assert.ok(!policy.holdsHome('sess:burn', { resolve: () => HOME }))
    const again = reserveArgs('sess:burn', bigBody())
    assert.equal(await policy.compactionReserve(again), null)
    assert.ok(again.selectArgs.excluded.has('vm-04'))
    // The session moved to another account that is down to its reserve too.
    const moved = await policy.compactionReserve({
      ...reserveArgs('sess:burn', bigBody(), { home: OTHER }),
      scheduler: { async eligibleCandidates() { return [{ ...OTHER, draining: false, headroom: 0.01 }] } },
    })
    assert.equal(moved.status, 400)
  } finally {
    Date.now = realNow
  }
})

test('a session that compacted inside the reserve is not forced there; one that compacted earlier is', async (t) => {
  const { sticky, stickyKey } = setup(t, 'manual')
  const policy = new SessionCachePolicy()
  const compactOn = (headroom) =>
    policy.selectCompactionHome({
      scheduler: scheduler({ home: { draining: false, headroom } }),
      stickyRouter: sticky,
      stickyKey,
      body: bigBody(COMPACT_TEXT),
      selectArgs: { model: 'claude-opus-test' },
    })
  const reserve = () => policy.compactionReserve({ ...reserveArgs(stickyKey, bigBody()), stickyRouter: sticky })
  assert.equal((await compactOn(0.5)).vmId, 'vm-04')
  assert.equal((await reserve()).status, 400)
  policy.forcedAt.clear()
  assert.equal((await compactOn(0.02)).vmId, 'vm-04')
  assert.equal(await reserve(), null)
})

test('mid-turn the forced compaction ends the turn with a pause reply', async () => {
  const policy = new SessionCachePolicy()
  const body = bigBody()
  body.messages[2] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] }
  const forced = await policy.compactionReserve(reserveArgs('sess:mid', body))
  assert.equal(forced.status, 400)
  assert.equal(forced.customReply.stop_reason, 'end_turn')
  assert.ok(forced.customReply.content[0].text.startsWith(PAUSE_MARKER))
})

test('a system reminder after the tool results is still mid-turn', async () => {
  const policy = new SessionCachePolicy()
  const body = bigBody()
  body.messages[2] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] }
  body.messages.push({ role: 'system', content: '<total_tokens>1 tokens left</total_tokens>' })
  const forced = await policy.compactionReserve(reserveArgs('sess:mid-system', body))
  assert.ok(forced.customReply.content[0].text.startsWith(PAUSE_MARKER))
})

test('the pause reply streams as a complete Anthropic message', () => {
  const message = {
    type: 'message',
    id: 'msg_p',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'text', text: 'pause' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  let out = ''
  let ended = false
  const res = { headersSent: false, write: (chunk) => (out += chunk), end: () => (ended = true) }
  writeAssistantReply(res, message, { stream: true, writeSSEHeaders: (r) => (r.headersSent = true), json: null })
  const events = out.split('\n\n').filter(Boolean)
  assert.deepEqual(
    events.map((e) => e.split('\n')[0]),
    [
      'event: message_start',
      'event: content_block_start',
      'event: content_block_delta',
      'event: content_block_stop',
      'event: message_delta',
      'event: message_stop',
    ],
  )
  assert.equal(JSON.parse(events[2].split('\ndata: ')[1]).delta.text, 'pause')
  assert.ok(ended && res.headersSent)
  let sent = null
  writeAssistantReply({}, message, { stream: false, json: (_res, status, body) => (sent = { status, body }) })
  assert.equal(sent.status, 200)
})

test('disabled config changes nothing', async () => {
  const policy = new SessionCachePolicy({
    config: () => mergeCustomConfig({ follow: { enabled: false }, force_compact: { enabled: false } }),
  })
  const args = reserveArgs('sess:x', bigBody())
  assert.equal(await policy.compactionReserve(args), null)
  assert.equal(args.selectArgs.excluded.size, 0)
  assert.equal(
    policy.follow({ stickyRouter: { resolve: () => HOME }, selected: { ...OTHER, selectionReason: 'balanced' } }),
    false,
  )
})

function weekly(unit, resetInHours, extra = {}) {
  const reset = String(Math.floor((Date.now() + resetInHours * 3_600_000) / 1000))
  return {
    ...unit,
    priority: 0,
    seatCap: 4,
    draining: false,
    headroom: 0.9,
    account: { unified: { headers: { '7d': { utilization: 0.5, reset, status: 'allowed' } } } },
    ...extra,
  }
}

function weeklyScheduler(units) {
  return {
    async eligibleCandidates({ onlyVmIds = null, excluded = new Set() } = {}) {
      return units.filter(
        (c) => (!onlyVmIds || onlyVmIds.has(c.vmId)) && !excluded.has(c.vmId) && !excluded.has(c.accountId),
      )
    },
    async selectAndReserve({ excluded = new Set() } = {}) {
      const unit = units.find((c) => !excluded.has(c.vmId))
      return { ok: true, ...unit, selectionReason: 'sticky', release() {} }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
}

test('a compaction on the later-resetting account moves the session to the earlier one once it has budget', async (t) => {
  const { sticky, stickyKey } = setup(t, 'rehome')
  const runner = new FailoverRunner({
    scheduler: weeklyScheduler([weekly(HOME, 100), weekly(OTHER, 20)]),
    stickyRouter: sticky,
  })
  let servedOn = null
  const result = await runner.run({
    requestId: 'rehome',
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
  const pin = sticky.resolve(stickyKey)
  assert.equal(pin.vmId, 'vm-01')
  assert.equal(pin.accountId, 'account-1')
  assert.equal(pin.sessionId, null)
})

test('rehome after compaction needs a compaction, a healthy home and a preferred account with budget', async () => {
  const policy = new SessionCachePolicy()
  const bound = []
  const stickyRouter = { bind: (key, payload) => bound.push([key, payload.vmId]) }
  const rehome = (units, body = bigBody(COMPACT_TEXT)) =>
    policy.rehomeAfterCompaction({
      scheduler: weeklyScheduler(units),
      stickyRouter,
      selected: HOME,
      body,
      bindKeys: ['sess:x'],
    })
  assert.equal(await rehome([weekly(HOME, 100), weekly(OTHER, 20)], bigBody()), null)
  assert.equal(await rehome([weekly(HOME, 100), weekly(OTHER, 20, { headroom: 0.3 })]), null)
  assert.equal(await rehome([weekly(HOME, 100), weekly(OTHER, 20, { draining: true })]), null)
  assert.equal(await rehome([weekly(HOME, 20), weekly(OTHER, 100)]), null)
  assert.equal(await rehome([weekly(HOME, 20.2), weekly(OTHER, 20)]), null)
  assert.equal(await rehome([weekly(HOME, 100, { draining: true }), weekly(OTHER, 20)]), null)
  assert.deepEqual(bound, [])
  assert.equal(await rehome([weekly(HOME, 100), weekly(OTHER, 20)]), 'vm-01')
  assert.deepEqual(bound, [['sess:x', 'vm-01']])
  const off = new SessionCachePolicy({ config: () => mergeCustomConfig({ rehome_after_compact: { enabled: false } }) })
  const disabled = await off.rehomeAfterCompaction({
    scheduler: weeklyScheduler([weekly(HOME, 100), weekly(OTHER, 20)]),
    stickyRouter,
    selected: HOME,
    body: bigBody(COMPACT_TEXT),
    bindKeys: ['sess:x'],
  })
  assert.equal(disabled, null)
})

test('compaction requests are recognised by the summary instruction', () => {
  assert.equal(isCompactionRequest(bigBody(COMPACT_TEXT)), true)
  assert.equal(isCompactionRequest({ messages: [{ role: 'user', content: COMPACT_TEXT }] }), true)
  assert.equal(isCompactionRequest(bigBody()), false)
  assert.equal(isCompactionRequest({}), false)
})
