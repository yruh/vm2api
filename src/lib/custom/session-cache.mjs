/**
 * Fork-local (yruh/vm2api) session cache policy. Kept in one file so the
 * upstream files only carry a few call sites and rebases stay trivial.
 *
 * 1. follow: a session that a strategy pick (balanced / fill / priority-load)
 *    moved off its pinned VM, and that the new VM served, re-pins there. The
 *    prompt cache now lives on the new VM; without this the next free turn on
 *    the old home goes back to a cache that has expired by then.
 * 2. force_compact: before a large session leaves a home VM that is about to
 *    run out of 5h/7d budget, answer "prompt is too long" so Claude Code
 *    compacts first. The compaction request itself goes back to the home VM,
 *    where the cache is still warm, and only the short summary moves.
 *
 * Config: src/config/custom.json (KIN_CUSTOM_FILE overrides), re-read when
 * its mtime changes. The panel never writes this file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { routingConfigFile } from '../core/config.mjs'
import { estimatePromptTokens } from '../pool/quota-request-risk.mjs'

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
    // How long the compaction request may wait for its home VM before it
    // goes through normal selection.
    home_wait_ms: 20_000,
  }),
})

/** Strategy picks: the home VM was not chosen for something other than plain capacity. */
const FOLLOW_REASONS = new Set(['balanced', 'fill', 'priority-load'])
const COMPACTION_MARKER = 'Your task is to create a detailed summary of the conversation so far'

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
    /** stickyKey → last forced compaction (ms). */
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
      return { ...selected, selectionReason: 'compact-home' }
    }
    if (selected?.ok) selected.release?.()
    return null
  }

  /**
   * First hop of a large session about to leave a home that is running out:
   * the "prompt is too long" result to return instead, or null to proceed.
   */
  async forceCompaction({ scheduler, stickyRouter, stickyKey, selected, body, selectArgs }) {
    const cfg = this.config().force_compact
    if (!cfg.enabled || !stickyKey || selectArgs?.pinVmId) return null
    if (!FOLLOW_REASONS.has(selected?.selectionReason)) return null
    const home = stickyRouter?.resolve?.(stickyKey)
    if (!home?.vmId || home.vmId === selected.vmId) return null
    if (isCompactionRequest(body)) return null
    const now = Date.now()
    const last = this.forcedAt.get(stickyKey) || 0
    if (now - last < Number(cfg.cooldown_ms || 0)) return null
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
      if (cfg.when_home_unavailable) reason = 'home_unavailable'
    } else if (candidate.draining) {
      reason = 'home_draining'
    } else if (candidate.headroom != null && Number(candidate.headroom) <= Number(cfg.trigger_headroom)) {
      reason = 'home_low_headroom'
    }
    if (!reason) return null
    this.forcedAt.set(stickyKey, now)
    if (this.forcedAt.size > 4096) this.forcedAt.delete(this.forcedAt.keys().next().value)
    console.log(
      `[custom] force compaction ${stickyKey} home=${home.vmId} next=${selected.vmId} reason=${reason} est_tokens=${tokens}`,
    )
    return promptTooLongError(Math.max(tokens, minTokens + 1), minTokens, {
      reason,
      home_vm: home.vmId,
      next_vm: selected.vmId,
      headroom: candidate?.headroom ?? null,
    })
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
}

export const sessionCachePolicy = new SessionCachePolicy()
