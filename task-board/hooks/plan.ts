// 任务板明细用的纯函数：阶段分组、耗时格式、模型名、隐藏判断、小图标。不碰 $（$ 不能跨 import 传）。

import type { Prefs, ScanLine, SessionRow, Step, SubRow, Usage } from '../types'

export type Stage = { name: string; steps: Step[]; done: number; total: number; sec: number; state: 'done' | 'current' | 'todo' }

/** 阶段前缀最长几个字：太长多半不是“阶段名: 步骤名”，而是标题里本来就有冒号。 */
const PREFIX_MAX = 24

/** "阶段名: 步骤名" 或 "阶段名：步骤名" → [阶段名, 步骤名]；没有前缀返回 null。 */
export function splitStage(title: string): [string, string] | null {
  const m = /^\s*([^:：]{1,40}?)\s*[:：]\s*(.+)$/.exec(title)
  const stage = m?.[1]
  const step = m?.[2]
  if (stage === undefined || step === undefined || stage.length > PREFIX_MAX) return null
  return [stage, step]
}

/**
 * 按标题前缀把步骤分成阶段，相邻同名的归在一起；没写前缀的跟着上一个阶段
 * （开头就没有前缀时归到一个不带名字的阶段）。一个前缀都没有 = 一个阶段。
 */
export function stagesOf(steps: Step[]): Stage[] {
  const out: Stage[] = []
  steps.forEach((st, i) => {
    const sp = splitStage(st.t)
    const name = sp ? sp[0] : (out[out.length - 1]?.name ?? '')
    const step = sp ? { ...st, t: sp[1], i } : { ...st, i }
    let cur = out[out.length - 1]
    if (!cur || cur.name !== name) {
      cur = { name, steps: [], done: 0, total: 0, sec: 0, state: 'todo' }
      out.push(cur)
    }
    cur.steps.push(step)
  })
  for (const g of out) {
    g.total = g.steps.length
    g.done = g.steps.filter(x => x.s === 'completed').length
    g.sec = g.steps.reduce((n, x) => n + Math.max(0, x.sec), 0)
    const started = g.steps.some(x => x.s !== 'pending')
    g.state = g.done === g.total ? 'done' : started ? 'current' : 'todo'
  }
  return out
}

/** 步骤表的一行：一步，或一整个折叠起来的阶段（没有 step）；first = 这个阶段的第一行（只在这行写阶段名）。 */
export type StepLine = { stage: Stage; step?: Step; first: boolean }

/** 步骤表最多画几行（明细面板在输入框上方，不能太高）。 */
export const STEP_MAX = 8

/**
 * 步骤表的行：超过 max 行时先把做完的阶段各折成一行（“2 steps ✓ 6m 51s”），
 * 还不够再折没开始的阶段；当前阶段始终展开。只有一步的阶段折了也不省行，不折。
 */
export function stepLines(stages: Stage[], max = STEP_MAX): StepLine[] {
  const fold = new Set<Stage>()
  const count = () => stages.reduce((n, g) => n + (fold.has(g) ? 1 : g.steps.length), 0)
  for (const state of ['done', 'todo'] as const) {
    if (count() <= max) break
    for (const g of stages) if (g.state === state && g.steps.length > 1) fold.add(g)
  }
  return stages.flatMap((g): StepLine[] =>
    fold.has(g) ? [{ stage: g, first: true }] : g.steps.map((step, i) => ({ stage: g, step, first: i === 0 })),
  )
}

/** 34s / 4m 24s / 1h 02m。 */
export function dur(sec: number) {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** 12:04 / 1:02:04（行尾的总耗时）。 */
export function clock(sec: number) {
  const s = Math.max(0, Math.round(sec))
  const mm = String(Math.floor((s % 3600) / 60))
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

/** claude-haiku-4-5-20251001 → haiku 4.5；认不出就原样去掉 claude- 前缀。 */
export function modelName(id: string) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id)
  if (!m) return id.replace(/^claude-/, '')
  return `${m[1]} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`
}

/** 会话最后一次请求的时间（毫秒）；没有请求就用 transcript 最后一次变动。 */
export function lastReqMs(at: number, s: SessionRow) {
  return at - (s.cacheAgeSec >= 0 ? s.cacheAgeSec : s.ageSec) * 1000
}

/** 手动隐藏过、且之后没有新请求、也没在跑的会话不上任务板。容差 15 秒（扫描时间取整）。 */
export function isHidden(prefs: Prefs | undefined, at: number, s: SessionRow) {
  const h = prefs?.hidden?.[s.id]
  if (h === undefined || s.status === 'input' || s.status === 'running' || s.status === 'waiting') return false
  return lastReqMs(at, s) <= h + 15_000
}

/** 写回开关文件前清掉 3 天前的隐藏记录，文件不会越攒越大。 */
export function pruneHidden(hidden: Record<string, number>, now: number) {
  const keep: Record<string, number> = {}
  for (const [id, t] of Object.entries(hidden)) if (now - t < 3 * 86_400_000) keep[id] = t
  return keep
}

/**
 * 子代理按“哪一步派出去的”分组：byStep = 步骤序号 → 子代理；loose = 不在任何一步里的
 * （没有清单、在两步之间派的，或者那一步已经不在清单里了）。
 */
export function subsByStep(subs: SubRow[], stepCount: number) {
  const byStep = new Map<number, SubRow[]>()
  const loose: SubRow[] = []
  for (const x of subs) {
    const k = x.step ?? -1
    if (k < 0 || k >= stepCount) loose.push(x)
    else byStep.set(k, [...(byStep.get(k) ?? []), x])
  }
  return { byStep, loose }
}

/** 主会话那一行：模型 · 推理强度 · 这一轮有没有子代理。 */
export function mainLine(model: string | null | undefined, effort: string | null | undefined, subs: SubRow[]) {
  const running = subs.filter(x => x.active).length
  const agents =
    subs.length === 0
      ? 'no subagents this turn'
      : `${subs.length} subagent${subs.length > 1 ? 's' : ''} this turn${running > 0 ? ` · ${running} running` : ''}`
  return [model ? modelName(model) : '', effort ?? '', agents].filter(Boolean).join(' · ')
}

/** 画不下的子代理汇总成一行：“+3 more agents · 1 running · 2 done”。 */
export function moreSubs(rest: SubRow[]) {
  const running = rest.filter(x => x.active).length
  const done = rest.length - running
  return [`+${rest.length} more agent${rest.length > 1 ? 's' : ''}`, running ? `${running} running` : '', done ? `${done} done` : '']
    .filter(Boolean)
    .join(' · ')
}

/** 清单还有没做完的步骤（做完了的清单不再代表“现在在干什么”）。 */
export const planOpen = (s: SessionRow) => s.total > 0 && s.done < s.total

/**
 * 总耗时：清单没做完用清单的（第一步建立起）；清单做完了但会话还在跑、或者没有清单，
 * 用这一轮的（不然会停在清单做完那一刻，看着像卡住）。
 */
export function elapsed(s: SessionRow) {
  const p = s.planSec ?? -1
  const t = s.turnSec ?? -1
  if (p >= 0 && planOpen(s)) return p
  if ((s.status === 'running' || s.status === 'input' || s.status === 'waiting') && t >= 0) return t
  return p >= 0 ? p : t
}

/**
 * 共用快照 → 现在的读数：快照是 `at` 那一刻的，所有“过了多少秒”都往后推 (now - at)，
 * 缓存倒计时、用时、隐藏判断才对得上。太旧（超过 maxSec）或不是快照的返回 null。
 */
export function rebaseScan(got: unknown, now: number, maxSec: number): ScanLine | null {
  const g = got as ScanLine | null
  if (!g || typeof g.at !== 'number' || g.at <= 0 || !Array.isArray(g.sessions)) return null
  const d = Math.max(0, Math.round((now - g.at) / 1000))
  if (d > maxSec) return null
  const later = (sec: number | undefined) => (typeof sec === 'number' && sec >= 0 ? sec + d : sec)
  const sessions = g.sessions.map(s => ({
    ...s,
    ageSec: s.ageSec + d,
    cacheAgeSec: later(s.cacheAgeSec) ?? -1,
    turnSec: later(s.turnSec),
    planSec: planOpen(s) ? later(s.planSec) : s.planSec,
    steps: s.steps?.map(x => (x.s === 'in_progress' ? { ...x, sec: later(x.sec) ?? -1 } : x)),
    subs: s.subs?.map(x => (x.active ? { ...x, sec: x.sec + d } : x)),
  }))
  return { ...g, at: g.at + d * 1000, sessions }
}

/**
 * 别的电脑的快照并入本机的会话。扫描进程把共享目录里其他设备的快照原样附在 remote 里；
 * 这里按本机这一轮的 at 把远端的秒数往后推（rebaseScan），超过 maxSec 的设备当离线跳过，
 * 每个远端会话打上 device / os。本机的会话优先；同一 id 出现在几份远端快照里（同步盘的冲突副本）取 at 最新的。
 */
export function mergeRemote(got: ScanLine, maxSec: number): SessionRow[] {
  const own = got.sessions ?? []
  const ids = new Set(own.map(s => s.id))
  const picked = new Map<string, { at: number; s: SessionRow }>()
  for (const r of got.remote ?? []) {
    if (!r || typeof r.device !== 'string' || r.device === '') continue
    const rb = rebaseScan(r, got.at, maxSec)
    if (!rb) continue
    for (const s of rb.sessions) {
      if (ids.has(s.id)) continue
      const prev = picked.get(s.id)
      if (prev && prev.at >= r.at) continue
      picked.set(s.id, { at: r.at, s: { ...s, device: r.device, os: r.os } })
    }
  }
  return [...own, ...[...picked.values()].map(x => x.s)]
}

/** 设备标签：win → Win、mac → Mac；别的原样。 */
export const osLabel = (os: string | undefined) => (os === 'win' ? 'Win' : os === 'mac' ? 'Mac' : (os ?? ''))

// ── 小图标（22×22，细线；颜色写死，因为 Svg 不跟随主题文字色）──────────────

const MUTED = '#8a877f'
const BLUE = '#3b82f6'

/** 16px 显示（和一行字一样高，不撑高卡片），按 22 的坐标画。展开按钮：收起时灰色向下箭头；展开时浅蓝圆角底 + 蓝色向上箭头。 */
export function chevronSvg(open: boolean) {
  const bg = open ? `<rect x="0.5" y="0.5" width="21" height="21" rx="6" fill="${BLUE}" fill-opacity=".14"/>` : ''
  const path = open ? 'M7.5 12.75 11 9.25l3.5 3.5' : 'M7.5 9.25 11 12.75l3.5-3.5'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 22 22">${bg}` +
    `<path d="${path}" fill="none" stroke="${open ? BLUE : MUTED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  )
}

/**
 * 任务板收起 / 展开的小箭头：16px、灰色细线、不填底色（和 Running 卡片上的展开箭头同一画法）。
 * 展开着 = 向下（点了收起）；收起着 = 向上（点了展开）。
 */
export function foldSvg(folded: boolean) {
  const path = folded ? 'M7.5 12.75 11 9.25l3.5 3.5' : 'M7.5 9.25 11 12.75l3.5-3.5'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 22 22">` +
    `<path d="${path}" fill="none" stroke="${MUTED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  )
}

/** 隐藏按钮：眼睛加一道斜线。 */
export function eyeOffSvg() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 22 22">` +
    `<g transform="translate(3 3)" fill="none" stroke="${MUTED}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M2.2 8.2C3.5 5.7 5.6 4.4 8 4.4s4.5 1.3 5.8 3.8C12.5 10.7 10.4 12 8 12S3.5 10.7 2.2 8.2Z"/>` +
    `<circle cx="8" cy="8.2" r="1.9"/><path d="M3 13.2 13 3.2"/></g></svg>`
  )
}

/**
 * 阶段条一段：4px 圆角，不做动画。完成 = 绿色满格；当前 = 蓝色按完成比例；
 * 未开始 = 只有灰轨道。
 */
export function segSvg(state: Stage['state'], done: number, total: number) {
  const track = `<rect x="0" y="0" width="100%" height="4" rx="2" fill="${MUTED}" fill-opacity=".22"/>`
  let fill = ''
  if (state === 'done') fill = `<rect x="0" y="0" width="100%" height="4" rx="2" fill="#34a853"/>`
  else if (state === 'current' && total > 0 && done > 0) {
    fill = `<rect x="0" y="0" width="${((done / total) * 100).toFixed(2)}%" height="4" rx="2" fill="${BLUE}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="4">${track}${fill}</svg>`
}

// ── 账号用量圆环（仿右下角“上下文”那个小圆圈）──────────────────────────

/** 两份读数取新的那份（本会话自己读到的 / 扫描进程转来的别的会话的）。 */
export function freshest(a: Usage | undefined, b: Usage | undefined) {
  if (!a || a.limits.length === 0) return b
  if (!b || b.limits.length === 0) return a
  return a.at >= b.at ? a : b
}

/**
 * 某个额度窗口此刻的样子：已用百分比、离重置还有几秒（不知道 = -1）。
 * 读数里的重置时间已经过了 = 窗口已经清零，按 0% 算。没有这个窗口返回 null。
 */
export function limitNow(u: Usage | undefined, kind: string, now: number) {
  const l = u?.limits.find(x => x.kind === kind)
  if (!l) return null
  const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  const left = Number.isNaN(at) ? -1 : Math.round((at - now) / 1000)
  if (!Number.isNaN(at) && left <= 0) return { pct: 0, left: -1 }
  return { pct: Math.max(0, Math.min(100, l.percentUsed)), left }
}

/** 离重置还有多久：45 min / 2h 13m。 */
export function resetIn(sec: number) {
  const m = Math.max(1, Math.ceil(sec / 60))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** 圆环颜色：平时灰，80% 起橙色，95% 起红色。 */
export const ringHex = (pct: number) => (pct >= 95 ? '#e5484d' : pct >= 80 ? '#d97757' : '#b9b6ad')

/** 16px 圆环：淡色整圈轨道 + 从 12 点钟方向顺时针画到已用比例，不做动画。 */
export function ringSvg(pct: number) {
  const r = 6
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct))
  const len = ((p / 100) * c).toFixed(2)
  const color = ringHex(p)
  const arc =
    p > 0
      ? `<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" ` +
        `stroke-dasharray="${len} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/>`
      : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="${r}" fill="none" stroke="${MUTED}" stroke-opacity=".25" stroke-width="2.5"/>${arc}</svg>`
  )
}

/** 33%（清单 / 阶段的完成比例）。 */
export const percent = (done: number, total: number) => `${Math.round((done / Math.max(1, total)) * 100)}%`
