/**
 * Fork-local (yruh/vm2api) session cache policy. Kept in one file so the
 * upstream files only carry a few call sites and rebases stay trivial.
 *
 * 1. follow: a session that a strategy pick (balanced / fill / priority-load)
 *    or a device / family affinity moved off its pinned VM, and that the new
 *    VM served, re-pins there. The prompt cache now lives on the new VM;
 *    without this the next free turn on the old home (or the compaction turn,
 *    which goes to the pin) lands on a cache that has expired by then, and
 *    every turn elsewhere gets a fresh outbound session.
 * 2. force_compact: once a large session's home VM is about to run out of
 *    5h/7d budget, answer "prompt is too long" so Claude Code compacts first.
 *    This fires on the turn that stays on the draining home (seated sessions
 *    keep running there until upstream rejects, and by then the home is gone)
 *    as well as on a strategy move away from it. The compaction request itself
 *    goes back to the home VM, where the cache is still warm, and only the
 *    short summary moves. Claude Code answers that error with a compaction
 *    that keeps the running turn verbatim, so mid-turn (the request carries
 *    tool results) the turn is ended instead with a short assistant reply
 *    asking for /compact; the cc-compact-on-pause mod runs it.
 * 3. rehome_after_compact: after a compaction turn, when the account new seats
 *    prefer (7d reset first, seat-order.mjs) has its budget back, re-pin the
 *    session and its device there. The summary is short, so the move costs
 *    almost no cache, and spending goes back to the earlier-resetting week.
 *
 * Config: src/config/custom.json (KIN_CUSTOM_FILE overrides), re-read when
 * its mtime changes. The panel never writes this file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { routingConfigFile } from '../core/config.mjs'
import { estimatePromptTokens } from '../pool/quota-request-risk.mjs'
import { outranksByWeeklyReset } from './seat-order.mjs'

export const DEFAULT_CUSTOM_CONFIG = Object.freeze({
  follow: Object.freeze({ enabled: true }),
  force_compact: Object.freeze({
    enabled: true,
    // Estimated prompt tokens (leans high) a session needs before it is worth compacting.
    min_prompt_tokens: 100_000,
    // Home counts as running out when the scheduler marks it draining, or when
    // its remaining budget (configured limit minus usage) is at most this.
    trigger_headroom: 0.03,
    // Also force when the home VM has already left the pool. The compaction
    // then runs cold on another VM, so it saves nothing up front.
    when_home_unavailable: false,
    // One forced compaction per session within this window, so a client that
    // does not compact is never locked out.
    cooldown_ms: 15 * 60 * 1000,
    // Once compacted on a home, a session is not forced again on that same
    // home within this window: it keeps running there until the account is
    // really used up (a 100% limit can be spent to the end). Compacting again
    // on the same account saves nothing.
    once_per_home_ms: 7 * 24 * 60 * 60 * 1000,
    // How long the compaction request may wait for its home VM before it
    // goes through normal selection.
    home_wait_ms: 20_000,
  }),
  // seat-order.mjs: new seats prefer the account whose 7d window resets first.
  weekly_reset_first: Object.freeze({
    enabled: true,
    // Resets this close together count as a tie and keep the upstream order.
    tie_minutes: 60,
  }),
  rehome_after_compact: Object.freeze({
    enabled: true,
    // Remaining budget (configured limit minus usage) the preferred account
    // needs before a compacted session moves to it.
    min_headroom: 0.5,
  }),
})

/** The home VM was not chosen for something other than plain capacity (sticky-spill keeps the pin). */
const FOLLOW_REASONS = new Set(['balanced', 'fill', 'priority-load', 'device-affinity', 'family-affinity'])
const COMPACTION_MARKER = 'Your task is to create a detailed summary of the conversation so far'
/** Opens the pause reply; the cc-compact-on-pause mod compacts when a turn ends with it. */
export const PAUSE_MARKER = '[vm2api:compact]'

let cached = { file: '', mtimeMs: -1, config: DEFAULT_CUSTOM_CONFIG }

export function customConfigFile() {
  const override = String(process.env.KIN_CUSTOM_FILE || '').trim()
  if (override) return override
  return path.join(path.dirname(routingConfigFile()), 'custom.json')
}

export function mergeCustomConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    follow: { ...DEFAULT_CUSTOM_CONFIG.follow, ...(src.follow || {}) },
    force_compact: { ...DEFAULT_CUSTOM_CONFIG.force_compact, ...(src.force_compact || {}) },
    weekly_reset_first: { ...DEFAULT_CUSTOM_CONFIG.weekly_reset_first, ...(src.weekly_reset_first || {}) },
    rehome_after_compact: { ...DEFAULT_CUSTOM_CONFIG.rehome_after_compact, ...(src.rehome_after_compact || {}) },
  }
}

export function customConfig() {
  const file = customConfigFile()
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    mtimeMs = 0
  }
  if (cached.file === file && cached.mtimeMs === mtimeMs) return cached.config
  let config = DEFAULT_CUSTOM_CONFIG
  if (mtimeMs) {
    try {
      config = mergeCustomConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      console.warn(`[custom] ${file} unreadable, using defaults: ${error?.message || error}`)
    }
  }
  cached = { file, mtimeMs, config }
  return config
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Claude Code's compaction turn: the conversation plus one summary instruction. */
export function isCompactionRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue
    return textOf(messages[i].content).includes(COMPACTION_MARKER)
  }
  return false
}

/** The request continues a turn: its last user message carries tool results. */
function isMidTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  // Claude Code appends system-role reminders after the tool results.
  const last = messages.findLast((message) => message?.role !== 'system')
  return (
    last?.role === 'user' && Array.isArray(last.content) && last.content.some((block) => block?.type === 'tool_result')
  )
}

function pauseReply(body, homeVmId) {
  const text =
    `${PAUSE_MARKER} 当前账号（${homeVmId}）额度快用完了，这一轮先停在这里，免得带着整段上下文换号重写缓存。` +
    '装了 cc-compact-on-pause 的几秒内会自动压缩；没看到 "Compacted" 就手动执行 /compact。压缩完再发"继续"。'
  return {
    type: 'message',
    id: `msg_vm2api_pause_${Date.now().toString(36)}`,
    role: 'assistant',
    model: body?.model || '',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

/** Sends a pause reply as an Anthropic message, streamed when the client asked for a stream. */
export function writeAssistantReply(res, message, { stream, writeSSEHeaders, json }) {
  if (!stream) return json(res, 200, message)
  if (!res.headersSent) writeSSEHeaders(res)
  const event = (type, data = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message: { ...message, content: [], stop_reason: null } })
  message.content.forEach((block, index) => {
    event('content_block_start', { index, content_block: { type: 'text', text: '' } })
    event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
    event('content_block_stop', { index })
  })
  event('message_delta', {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  })
  event('message_stop')
  return res.end()
}

function promptTooLongError(tokens, maximum, details) {
  return {
    ok: false,
    status: 400,
    via: 'pool-failover',
    terminalState: 'rejected',
    body: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'custom_force_compact',
        message: `prompt is too long: ${tokens} tokens > ${maximum} maximum`,
        details,
      },
    },
  }
}

export class SessionCachePolicy {
  constructor({ config = customConfig } = {}) {
    this.config = config
    /** stickyKey → last forced compaction { at (ms), vmId }. */
    this.forcedAt = new Map()
  }

  /**
   * The compaction turn of a pinned session: try its home VM first. Returns a
   * reservation, or null to fall through to normal selection.
   */
  async selectCompactionHome(args = {}) {
    try {
      return await this.compactionHome(args)
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'selection_cancelled') throw error
      console.warn(`[custom] compaction home selection failed: ${error?.message || error}`)
      return null
    }
  }

  async compactionHome({ scheduler, stickyRouter, stickyKey, body, selectArgs }) {
    const cfg = this.config().force_compact
    if (!cfg.enabled || !stickyKey || selectArgs?.pinVmId || !isCompactionRequest(body)) return null
    if (typeof scheduler?.eligibleCandidates !== 'function') return null
    const home = stickyRouter?.resolve?.(stickyKey)
    if (!home?.vmId) return null
    const all = await scheduler.eligibleCandidates({
      model: selectArgs.model,
      excluded: selectArgs.excluded,
      ownerScope: selectArgs.ownerScope,
      keyScope: selectArgs.keyScope,
    })
    if (!all.some((candidate) => candidate.vmId === home.vmId)) return null
    const excluded = new Set(selectArgs.excluded || [])
    for (const candidate of all) {
      if (candidate.vmId === home.vmId) continue
      excluded.add(candidate.vmId)
      excluded.add(candidate.accountId)
    }
    const deadline = Math.min(Number(selectArgs.deadline) || Infinity, Date.now() + Number(cfg.home_wait_ms || 0))
    const selected = await scheduler.selectAndReserve({ ...selectArgs, excluded, deadline, allowWait: true })
    if (selected?.ok && selected.vmId === home.vmId) {
      console.log(`[custom] compaction ${stickyKey} on home=${home.vmId}`)
      return { ...selected, selectionReason: 'compact-home' }
    }
    if (selected?.ok) selected.release?.()
    return null
  }

  /**
   * First hop of a large session whose home is running out, either staying
   * on it or moved off it by a strategy pick: the "prompt is too long" result
   * to return instead, or null to proceed.
   */
  async forceCompaction({ scheduler, stickyRouter, stickyKey, selected, body, selectArgs }) {
    const cfg = this.config().force_compact
    if (!cfg.enabled || !stickyKey || selectArgs?.pinVmId || !selected?.vmId) return null
    const home = stickyRouter?.resolve?.(stickyKey)
    if (!home?.vmId) return null
    const staying = home.vmId === selected.vmId
    if (!staying && !FOLLOW_REASONS.has(selected.selectionReason)) return null
    if (isCompactionRequest(body)) return null
    const now = Date.now()
    const last = this.forcedAt.get(stickyKey)
    if (last && now - last.at < Number(cfg.cooldown_ms || 0)) return null
    if (last && last.vmId === home.vmId && now - last.at < Number(cfg.once_per_home_ms || 0)) return null
    const tokens = estimatePromptTokens(body)
    const minTokens = Math.max(1, Math.floor(Number(cfg.min_prompt_tokens) || 0))
    if (tokens < minTokens || typeof scheduler?.eligibleCandidates !== 'function') return null
    const [candidate] = await scheduler.eligibleCandidates({
      model: selectArgs.model,
      ownerScope: selectArgs.ownerScope,
      keyScope: selectArgs.keyScope,
      onlyVmIds: new Set([home.vmId]),
    })
    let reason = ''
    if (!candidate) {
      if (cfg.when_home_unavailable && !staying) reason = 'home_unavailable'
    } else if (candidate.draining) {
      reason = 'home_draining'
    } else if (candidate.headroom != null && Number(candidate.headroom) <= Number(cfg.trigger_headroom)) {
      reason = 'home_low_headroom'
    }
    if (!reason) return null
    this.forcedAt.delete(stickyKey)
    this.forcedAt.set(stickyKey, { at: now, vmId: home.vmId })
    if (this.forcedAt.size > 4096) this.forcedAt.delete(this.forcedAt.keys().next().value)
    const midTurn = isMidTurn(body)
    console.log(
      `[custom] force compaction ${stickyKey} home=${home.vmId} next=${staying ? 'home' : selected.vmId} reason=${reason} est_tokens=${tokens}${midTurn ? ' pause=mid_turn' : ''}`,
    )
    const error = promptTooLongError(Math.max(tokens, minTokens + 1), minTokens, {
      reason,
      home_vm: home.vmId,
      next_vm: selected.vmId,
      headroom: candidate?.headroom ?? null,
    })
    // Other protocols cannot carry the reply and get the error.
    return midTurn ? { ...error, customReply: pauseReply(body, home.vmId) } : error
  }

  /** After a verified hop: re-pin the session (and its device) where it was served. */
  follow({ stickyRouter, selected, bindKeys = [], deviceKey = null, sessionId = '' }) {
    if (!this.config().follow.enabled || !stickyRouter || !selected?.accountId || !selected?.vmId) return false
    if (!FOLLOW_REASONS.has(selected.selectionReason)) return false
    let moved = false
    for (const key of bindKeys) {
      const prev = stickyRouter.resolve?.(key)
      if (!prev?.accountId || prev.accountId === selected.accountId) continue
      const payload = { accountId: selected.accountId, vmId: selected.vmId }
      if (sessionId) payload.sessionId = sessionId
      stickyRouter.bind(key, payload, { countHit: false, allowMove: true, replaceSession: true })
      moved = true
    }
    if (deviceKey) {
      const prev = stickyRouter.resolve?.(deviceKey)
      if (prev?.vmId && prev.vmId !== selected.vmId) {
        stickyRouter.bindDeviceAffinity?.(deviceKey, { accountId: selected.accountId, vmId: selected.vmId })
        moved = true
      }
    }
    if (moved) console.log(`[custom] follow ${bindKeys[0] || deviceKey} -> ${selected.vmId}`)
    return moved
  }

  /**
   * After a verified compaction turn: re-pin the session and its device to
   * the account new seats prefer, once that one has budget again and the
   * serving VM does not already rank as high. Returns the new vmId or null.
   */
  async rehomeAfterCompaction({
    scheduler,
    stickyRouter,
    selected,
    body,
    bindKeys = [],
    deviceKey = null,
    selectArgs = {},
  }) {
    const cfg = this.config().rehome_after_compact
    if (!cfg.enabled || !stickyRouter || selectArgs.pinVmId || !selected?.vmId || !isCompactionRequest(body))
      return null
    if (typeof scheduler?.eligibleCandidates !== 'function') return null
    const all = await scheduler.eligibleCandidates({
      model: selectArgs.model,
      ownerScope: selectArgs.ownerScope,
      keyScope: selectArgs.keyScope,
    })
    const home = all.find((candidate) => candidate.vmId === selected.vmId)
    // A draining home is already left on the next turn by normal selection.
    if (!home || home.draining) return null
    const now = Date.now()
    const outranks = (left, right) => outranksByWeeklyReset(left, right, { config: this.config, now })
    const minHeadroom = Number(cfg.min_headroom) || 0
    const [target] = all
      .filter(
        (candidate) =>
          candidate.vmId !== home.vmId &&
          !candidate.draining &&
          candidate.headroom != null &&
          Number(candidate.headroom) >= minHeadroom &&
          scheduler.planner?.canOpen?.(candidate.vmId, candidate.seatCap, candidate.headroom) !== false &&
          outranks(candidate, home),
      )
      .sort(
        (left, right) =>
          (outranks(left, right) ? -1 : outranks(right, left) ? 1 : 0) ||
          Number(right.headroom) - Number(left.headroom),
      )
    if (!target) return null
    const payload = { accountId: target.accountId, vmId: target.vmId }
    for (const key of bindKeys) {
      stickyRouter.bind(key, payload, { countHit: false, allowMove: true, replaceSession: true })
    }
    if (deviceKey) stickyRouter.bindDeviceAffinity?.(deviceKey, payload)
    console.log(
      `[custom] rehome after compaction ${bindKeys[0] || deviceKey} ${home.vmId} -> ${target.vmId} headroom=${target.headroom}`,
    )
    return target.vmId
  }
}

export const sessionCachePolicy = new SessionCachePolicy()
