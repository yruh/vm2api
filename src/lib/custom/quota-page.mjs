/**
 * Fork-local (yruh/vm2api) quota page.
 *
 *   GET /quota               static page: paste an API key, see its accounts
 *   GET /v1/custom/quota     JSON for that key (Authorization: Bearer <key>)
 *
 * Lists every slot the key may be scheduled on (same owner/key scope as
 * Messages) with its 5h / 7d usage and reset time, read from the stored
 * usage snapshot. Read-only: never probes upstream, binds, or reserves.
 * Account e-mails are not exposed.
 */
import { ownerScopeFromRequest, vmMatchesOwnerScope } from '../admin/resource-owner.mjs'
import { keyAllowsVm, keyScopeFromRequest, vmPoolDenial } from '../admin/key-scope.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { summarizeCodexSlot } from '../vm/codex-slot.mjs'
import { listQuotaFromHeaders, publicUsageWindow } from '../pool/quota-window.mjs'
import { accountIdOf } from '../pool/pool-scheduler.mjs'

/** Header samples carry Unix seconds ("1793474400"), /usage samples ISO strings. */
function isoReset(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(value)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

function windowOf(listed, key) {
  const window = publicUsageWindow(
    listed?.[key] || {
      utilization: listed?.[`utilization_${key}`],
      status: listed?.[`status_${key}`],
      reset: listed?.[`reset_${key}`],
    },
  )
  return window ? { ...window, resets_at: isoReset(window.resets_at) } : null
}

export async function quotaView(req, { projectRoot, poolScheduler, usersRepo = null } = {}) {
  const keyScope = keyScopeFromRequest(req)
  const denial = vmPoolDenial(keyScope)
  if (denial) return { status: 403, body: { error: { type: 'permission_error', message: denial.message } } }
  const ownerScope = ownerScopeFromRequest(req, usersRepo)
  const vms = listVms(projectRoot)
    .filter((summary) => summary?.id)
    .map((summary) => getVm(projectRoot, summary.id))
    .filter((vm) => vm && vmMatchesOwnerScope(vm, ownerScope) && keyAllowsVm(keyScope, vm))

  const claude = vms.filter((vm) => !isCodexVm(vm))
  const accountIds = new Map(claude.map((vm) => [vm.id, accountIdOf(vm, projectRoot)]))
  const snapshots = poolScheduler?.runtimeRepo
    ? poolScheduler.runtimeRepo.schedulingSnapshot([...accountIds.values()].filter(Boolean))
    : new Map()
  const live = new Map()
  try {
    const candidates = (await poolScheduler?.eligibleCandidates?.({ ownerScope, keyScope })) || []
    for (const candidate of candidates) live.set(candidate.vmId, candidate)
  } catch {}

  const now = Date.now()
  const accounts = vms.map((vm) => {
    const candidate = live.get(vm.id)
    const state = candidate ? (candidate.draining ? 'draining' : candidate.busy ? 'busy' : 'available') : 'unavailable'
    let listed = {}
    let platform = 'claude'
    let tier = vm.tier || vm.claude?.tier || null
    if (isCodexVm(vm)) {
      platform = 'openai'
      listed = summarizeCodexSlot(projectRoot, vm).usage?.quota || {}
    } else {
      const account = snapshots.get(accountIds.get(vm.id))?.account || null
      tier = account?.unified?.account_tier || tier
      listed = account?.unified ? listQuotaFromHeaders(account.unified, { now }) : {}
    }
    return {
      vm_id: vm.id,
      name: vm.name || vm.id,
      platform,
      tier,
      state,
      five_hour: windowOf(listed, '5h'),
      seven_day: windowOf(listed, '7d'),
    }
  })
  return { status: 200, body: { generated_at: new Date(now).toISOString(), unit: 'percent_used', accounts } }
}

/** Returns true when the request was one of ours. */
export async function handleCustomRoute(req, res, p, deps) {
  if (req.method !== 'GET') return false
  if (p === '/quota') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(QUOTA_PAGE)
    return true
  }
  if (p === '/v1/custom/quota') {
    if (!deps.requireAuth(req, res)) return true
    const view = await quotaView(req, deps)
    deps.json(res, view.status, view.body)
    return true
  }
  return false
}

const QUOTA_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>额度查询</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1f2328; --muted:#6b7280; --line:#e5e7eb;
          --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --bar:#e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --fg:#e6e8eb; --muted:#9aa3ae;
          --line:#2a2f3a; --bar:#2a2f3a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
         background:var(--bg); color:var(--fg); }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  form { display:flex; gap:8px; margin-bottom: 8px; }
  input { flex:1; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card);
          color:var(--fg); font:inherit; }
  button { padding:10px 16px; border:0; border-radius:8px; background:#2563eb; color:#fff; font:inherit; cursor:pointer; }
  .meta { color:var(--muted); font-size:13px; min-height:20px; margin-bottom:16px; }
  .err { color:var(--bad); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:12px; }
  .head { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:8px; }
  .name { font-weight:600; }
  .tag { font-size:12px; color:var(--muted); margin-left:6px; }
  .state { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }
  .available { color:var(--ok); } .busy, .draining { color:var(--warn); } .unavailable { color:var(--bad); }
  .row { display:grid; grid-template-columns: 48px 1fr 64px; gap:10px; align-items:center; margin:6px 0; }
  .label { color:var(--muted); font-size:13px; }
  .bar { height:8px; background:var(--bar); border-radius:999px; overflow:hidden; }
  .bar > i { display:block; height:100%; border-radius:999px; }
  .pct { text-align:right; font-variant-numeric: tabular-nums; }
  .reset { grid-column: 2 / 4; color:var(--muted); font-size:13px; margin-top:-4px; }
</style>
</head>
<body>
<main>
  <h1>密钥额度查询</h1>
  <form id="f">
    <input id="k" type="password" placeholder="粘贴你的 API 密钥" autocomplete="off">
    <button>查询</button>
  </form>
  <div class="meta" id="meta">密钥只保存在本浏览器，用来向本服务查询。</div>
  <div id="list"></div>
</main>
<script>
const $ = (id) => document.getElementById(id)
const STATES = { available: '可用', busy: '忙', draining: '快用完', unavailable: '不可用' }
let timer = null
$('k').value = localStorage.getItem('vm2api_quota_key') || ''

function color(p) { return p >= 90 ? 'var(--bad)' : p >= 70 ? 'var(--warn)' : 'var(--ok)' }
function left(iso) {
  if (!iso) return ''
  const ms = new Date(iso) - Date.now()
  if (!(ms > 0)) return '已到刷新时间'
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  return (d ? d + ' 天 ' : '') + (d || h ? h + ' 小时 ' : '') + mm + ' 分钟后刷新'
}
function when(iso) {
  if (!iso) return '刷新时间未知'
  const t = new Date(iso)
  return t.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
function row(label, w) {
  const p = w && w.utilization != null ? Math.round(w.utilization) : null
  const bar = p == null ? '' : '<i style="width:' + Math.min(100, p) + '%;background:' + color(p) + '"></i>'
  const reset = w && w.resets_at ? when(w.resets_at) + ' · ' + left(w.resets_at) : (p == null ? '暂无数据' : '刷新时间未知')
  return '<div class="row"><span class="label">' + label + '</span><div class="bar">' + bar + '</div><span class="pct">' +
    (p == null ? '—' : p + '%') + '</span><span class="reset">' + reset + '</span></div>'
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';') }
async function load() {
  const key = $('k').value.trim()
  if (!key) return
  localStorage.setItem('vm2api_quota_key', key)
  try {
    const r = await fetch('/v1/custom/quota', { headers: { authorization: 'Bearer ' + key }, cache: 'no-store' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status))
    $('meta').textContent = '共 ' + d.accounts.length + ' 个账号 · 更新于 ' + new Date(d.generated_at).toLocaleTimeString('zh-CN') + ' · 每分钟自动刷新'
    $('list').innerHTML = d.accounts.map((a) =>
      '<div class="card"><div class="head"><div><span class="name">' + esc(a.name) + '</span><span class="tag">' +
      esc([a.platform === 'openai' ? 'Codex' : 'Claude', a.tier].filter(Boolean).join(' · ')) + '</span></div>' +
      '<span class="state ' + a.state + '">' + (STATES[a.state] || a.state) + '</span></div>' +
      row('5 小时', a.five_hour) + row('7 天', a.seven_day) + '</div>').join('') || '<div class="card">这个密钥没有可用的账号</div>'
  } catch (e) {
    $('meta').innerHTML = '<span class="err">查询失败：' + esc(e.message) + '</span>'
  }
}
$('f').addEventListener('submit', (e) => { e.preventDefault(); load(); clearInterval(timer); timer = setInterval(load, 60000) })
if ($('k').value) { load(); timer = setInterval(load, 60000) }
</script>
</body>
</html>
`
