import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Board, Fold, NextView, Prefs, ScanLine, SessionRow, SessionStatus, SubRow, Suggestion, Usage } from '../types'
import { costOf, forkPrompt, nextOptions, parseSuggestions, skillList } from './next-steps'
import { chevronSvg, clock, dur, elapsed, eyeOffSvg, foldSvg, freshest, isHidden, lastReqMs, limitNow, mainLine, mergeRemote, modelName, moreSubs, percent, planOpen, pruneHidden, rebaseScan, resetIn, ringHex, ringSvg, segSvg, stagesOf, stepLines, subsByStep } from './plan'

const PANE = 'task-board'
const TITLE = 'Sessions'

// ── 平台相关：Windows 版和 macOS 版的 register.tsx 只有这一段不同 ──────────────────
/** 后台扫描脚本（插件根目录下）。 */
const SCAN_SCRIPT = 'scan.ps1'
/** 启动扫描进程的命令行；shared 为空 = 不开跨设备共享。 */
const scanArgv = (script: string, shared: string, device: string) => [
  'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Hours', '24', '-Max', '12',
  ...(shared === '' ? [] : ['-Shared', shared, '-Device', device]),
]
/** 用户主目录（$.env.get 的变量名必须写成字面量），和共用快照的路径。 */
const homeOf = ($: EngineInterface) => $.env.get('USERPROFILE')
const snapshotPath = (home: string) => `${home}\\.claude\\task-board-snapshot.json`
/** 标题栏计数（counter.cs，counter.ps1 当场编译）的启动器：start 时已有同一份在跑就不动，脱离会话运行；stop 停掉。共享目录放最后，空就不传。 */
const MENUBAR_LAUNCHER = 'counter.ps1'
const menubarArgv = (root: string, ttlMin: number, shared: string, device: string) => [
  'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${root}/${MENUBAR_LAUNCHER}`, 'start', String(ttlMin), device,
  ...(shared === '' ? [] : [shared]),
]
const menubarStopArgv = (root: string) => ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${root}/${MENUBAR_LAUNCHER}`, 'stop']
/** 交给 Windows 打开 claude:// 链接，Claude 应用会切到对应会话。 */
const openArgv = (link: string) => ['rundll32.exe', 'url.dll,FileProtocolHandler', link]
/** 本机标签的默认值（设置项 deviceName 为空时用）：卡片上的灰色小标签、共享目录里的文件名都用它；有几台机器就各设各的。 */
const DEFAULT_DEVICE = 'Win'
/** 跨设备共享目录的默认位置（iCloud Drive；开头的 ~ 由扫描脚本展开成用户主目录）。 */
const DEFAULT_SHARED = '~/iCloudDrive/Claude Code/task-board-shared'

const board = atom({ plugin: 'task-board', key: 'board' } as const, { at: 0, tick: 0, sessions: [] } as Board)
const me = atom({ plugin: 'task-board', key: 'me' } as const, '')
const showAll = atom({ plugin: 'task-board', key: 'showAll' } as const, false)
/** 下一步建议：主会话一轮回答后 fork 一次本会话猜三条下一句，点一下填进输入框（从不自动发送）。 */
const nextView = atom({ plugin: 'task-board', key: 'next' } as const, { kind: 'hidden' } as NextView)
const HIDDEN: NextView = { kind: 'hidden' }
/** Running 栏里展开了明细的会话（'' = 都收起）；每个对话自己记。 */
const expanded = atom({ plugin: 'task-board', key: 'expanded' } as const, '')
/** 本会话自己最近一次读到的账号用量（别的会话读到的经扫描进程转来，在 board.usage）。 */
const usage = atom({ plugin: 'task-board', key: 'usage' } as const, { at: 0, limits: [] } as Usage)
/** 任务板收起了没有（本会话）；没记过的读 $.store 里上次的选择，再没有就用默认。 */
const fold = atom({ plugin: 'task-board', key: 'fold' } as const, {} as Fold)

/** 多久没动静就从“活跃”里收起（运行中 / 待处理的会话始终显示）。 */
const ACTIVE_SEC = 60 * 60

/** 提示缓存有效期和快过期提醒（秒），register 时按插件选项设置。 */
let TTL_SEC = 60 * 60
let WARN_SEC = 5 * 60
/** 跨设备共享目录（空 = 不共享）和本机标签（卡片标签 + 共享目录里的文件名；空 = 平台默认），register 时按插件选项设置，传给扫描进程。 */
let SHARED_DIR = ''
let DEVICE = ''
/** 菜单栏开关（设置项 menuBar，默认开） */
let MENU_BAR = true

/** 缓存还剩几秒：从主 transcript 最后一次请求起算；没有请求过返回 null。 */
const cacheLeft = (s: SessionRow) => (s.cacheAgeSec >= 0 ? TTL_SEC - s.cacheAgeSec : null)

function cacheText(left: number) {
  if (left <= 0) return 'cache expired'
  if (left < 600) return `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  return `⏱ ${Math.floor(left / 60)} min`
}

function cacheHex(left: number) {
  if (left <= 0) return '#8b8f98'
  if (left <= WARN_SEC) return '#e5484d'
  if (left <= 600) return '#f5b324'
  return '#34a853'
}

/**
 * 横条和详情窗“只看活跃”里留谁：运行中、待处理始终留；其余（本会话也一样）看最后一次请求
 * （不看 transcript 文件时间：应用重启会给每个会话补写元数据，文件时间就不准了），
 * 超过 ACTIVE_SEC 或缓存已过期就收起。
 */
function isActive(s: SessionRow) {
  if (isLive(s)) return true
  const quiet = s.cacheAgeSec >= 0 ? s.cacheAgeSec : s.ageSec
  const left = cacheLeft(s)
  return quiet < ACTIVE_SEC && (left === null || left > 0)
}

/** 已完成 / 闲置的会话改显示缓存倒计时（进行中的会话缓存一直是热的，照旧显示进度）。 */
const showsCache = (s: SessionRow) => (s.status === 'done' || s.status === 'idle') && cacheLeft(s) !== null

/** 在等我决定 = 黄色 needs input；单纯停在工具调用上（不需要我）= 浅蓝 waiting。 */
const LABEL: Record<SessionStatus, string> = { input: 'needs input', running: 'running', waiting: 'waiting', done: 'done', idle: 'idle' }
const COLOR: Record<SessionStatus, string> = { input: 'yellow', running: 'blue', waiting: 'cyan', done: 'green', idle: 'gray' }
const ORDER: Record<SessionStatus, number> = { input: 0, running: 1, waiting: 2, done: 3, idle: 4 }
const HEX: Record<SessionStatus, string> = { input: '#f5b324', running: '#3b82f6', waiting: '#7cc4f5', done: '#34a853', idle: '#8b8f98' }

/** 还在这一轮里的会话（左栏）：在等我、在跑、停在工具调用上。 */
const isLive = (s: SessionRow) => s.status === 'input' || s.status === 'running' || s.status === 'waiting'

/** 别的电脑上的会话（经共享目录读到，device = 那台电脑的标签）。 */
const isRemote = (s: SessionRow) => s.device !== undefined

/** Remote Control 的会话编号（Claude 应用的 claude://claude.ai/code/<编号> 只认这两种前缀）。 */
const BRIDGE_ID = /^(cse|session)_[A-Za-z0-9_-]+$/

/**
 * 点卡片打开的链接：本机的会话 = claude://claude.ai/epitaxy/local_…（切到那个会话）；
 * 别的电脑的会话 = 它的 Remote Control（claude://claude.ai/code/session_…，Claude 应用打开远程查看）；打不开 = ''。
 */
const goLink = (s: SessionRow) =>
  isRemote(s) ? (s.bridge !== undefined && BRIDGE_ID.test(s.bridge) ? `claude://claude.ai/code/${s.bridge}` : '') : s.link

/** 卡片挂不挂跳转点击层：本机的都挂（没链接的点了提示）；别的电脑的要有 Remote Control 编号（旧版本写的快照没有）。 */
const canOpen = (s: SessionRow) => !isRemote(s) || goLink(s) !== ''

/** 细圆角进度条（仿用量页）：淡色轨道 + 按比例的实色填充，不做动画。 */
function barSvg(s: SessionRow) {
  const W = 600
  const H = 6
  const c = HEX[s.status]
  const track = `<rect x="0" y="1" width="${W}" height="4" rx="2" fill="${c}" fill-opacity="0.18"/>`
  let fill = ''
  if (s.total > 0) {
    const w = Math.round((s.done / s.total) * W)
    if (w > 0) fill = `<rect x="0" y="1" width="${Math.max(4, w)}" height="4" rx="2" fill="${c}"/>`
  } else if (s.status === 'done' || s.status === 'waiting' || s.status === 'input') {
    fill = `<rect x="0" y="1" width="${W}" height="4" rx="2" fill="${c}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${track}${fill}</svg>`
}

/** 计费意义上的 token：输入 + 缓存写入 + 输出（缓存读取便宜，单独显示）。 */
const billed = (s: SessionRow) => s.input + s.cacheWrite + s.output

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

const ago = (sec: number) =>
  sec < 60 ? 'just now' : sec < 3600 ? `${Math.floor(sec / 60)} min ago` : `${Math.floor(sec / 3600)} h ago`

/** 终端显示宽度：中日韩字符和全角符号占两格。 */
function width(s: string) {
  let w = 0
  for (const ch of s) w += /[⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}

function fit(s: string, cols: number) {
  let out = ''
  let w = 0
  for (const ch of s.replace(/\s+/g, ' ')) {
    const cw = width(ch)
    if (w + cw > cols - (width(s) > cols ? 1 : 0)) {
      out += '…'
      w += 1
      break
    }
    out += ch
    w += cw
  }
  return out + ' '.repeat(Math.max(0, cols - w))
}

/** 横向进度条：有任务清单按完成比例；没有清单按状态填满或留空（不做动画）。 */
function bar(s: SessionRow, cols: number) {
  if (s.total > 0) {
    const filled = Math.round((s.done / s.total) * cols)
    return '█'.repeat(filled) + '░'.repeat(cols - filled)
  }
  if (s.status === 'done' || s.status === 'input') return '█'.repeat(cols)
  return '░'.repeat(cols)
}

async function publishStatus($: EngineInterface) {
  const b = await read($, board)
  const running = b.sessions.filter(s => s.status === 'running').length
  const tokens = b.sessions.reduce((n, s) => n + billed(s), 0)
  await $.ui.status(`${running} running / ${b.sessions.length} sessions · ${fmt(tokens)} tok`)
}

/** 本模块这次加载里已经确认过菜单栏（开着就确保在跑，关着就停掉），不用每次连上都再跑一遍启动器。 */
let menubarChecked = false

/** 菜单栏：设置项开着就确保在跑（启动器只留一个、脱离会话），关着就停掉。失败只记日志。 */
async function ensureMenubar($: EngineInterface) {
  if (menubarChecked) return
  menubarChecked = true
  try {
    const script = await scriptPath($)
    const root = script.slice(0, script.length - SCAN_SCRIPT.length - 1)
    const r = await $.process.run(MENU_BAR ? menubarArgv(root, TTL_SEC / 60, SHARED_DIR, DEVICE) : menubarStopArgv(root))
    if (r.exitCode !== 0) $.ui.log(`task-board: menu bar launcher exited ${r.exitCode}`, { to: 'debug' })
  } catch (err) {
    menubarChecked = false
    $.ui.log(`task-board: menu bar launcher failed: ${String(err)}`, { to: 'debug' })
  }
}

async function scriptPath($: EngineInterface) {
  const root = $.plugin.root.replace(/[\\/]+$/, '')
  const here = `${root}/${SCAN_SCRIPT}`
  if (await $.fs.exists(here)) return here
  return `${root.replace(/[\\/]\.claude-plugin$/, '')}/${SCAN_SCRIPT}`
}

/** 已经为哪一次请求提醒过（最后请求时间，10 秒取整），同一次请求只提醒一回。 */
let warnedReq = -1

/** 本会话的缓存剩 WARN_SEC 以内时弹一次提示；每个会话只管自己。 */
async function warnCache($: EngineInterface, at: number, sessions: SessionRow[]) {
  if (WARN_SEC <= 0) return
  const self = await read($, me)
  const s = sessions.find(x => x.id === self)
  const left = s ? cacheLeft(s) : null
  if (!s || left === null || left <= 0 || left > WARN_SEC || s.status === 'running') return
  const req = Math.round((at / 1000 - s.cacheAgeSec) / 10)
  if (req === warnedReq) return
  warnedReq = req
  await $.ui.toast(`This session's cache expires in ${Math.ceil(left / 60)} min — after that the next message rewrites the whole context`)
}

/** 本会话的扫描进程是否在跑（每个会话、每次模块加载只起一个）。 */
let isWatching = false

/** 后台扫描脚本：每 3 秒输出一行 JSON，模块重载或会话结束时随之退出。 */
async function watch($: EngineInterface) {
  if (isWatching) return
  isWatching = true
  try {
    const script = await scriptPath($)
    const child = $.process.spawn({
      argv: scanArgv(script, SHARED_DIR, DEVICE),
    })
    let pending = ''
    for await (const { stream, text } of child) {
      if (stream !== 'stdout') continue
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const got = JSON.parse(line) as ScanLine
          await update($, board, b => boardFrom(got, b))
          await publishStatus($)
          await warnCache($, got.at, got.sessions ?? [])
          // 别的对话把建议关了：本会话正在显示的建议也收起
          if (got.prefs?.nextSteps === false && (await read($, nextView)).kind !== 'hidden') {
            await update($, nextView, () => HIDDEN)
          }
        } catch {
          // 半行或非 JSON 输出，跳过
        }
      }
    }
    await update($, board, b => ({ ...b, error: 'Scanner exited — run /task-board to restart it' }))
  } catch (err) {
    // 从绘制里启动时失败，写状态会被拒（绘制期间不许写）：只记日志，下次绘制再试
    await update($, board, b => ({ ...b, error: `Scanner failed to start: ${String(err)}` })).catch(() =>
      $.ui.log(`Scanner failed to start: ${String(err)}`),
    )
  } finally {
    isWatching = false
  }
}

/** 扫描进程的一行（或共用快照）→ 任务板的数据；别的电脑的快照（remote）并入 sessions。 */
function boardFrom(got: ScanLine, b: Board): Board {
  return {
    at: got.at,
    tick: b.tick + 1,
    sessions: mergeRemote(got, SNAP_MAX_SEC),
    error: undefined,
    prefs: got.prefs,
    prefsPath: got.prefsPath,
    usagePath: got.usagePath,
    usage: parseUsage(got.usageText),
    inputDir: got.inputDir,
  }
}

/** 快照最多用多旧的（秒）：更旧的状态多半已经变了，宁可等扫描进程的第一行。 */
const SNAP_MAX_SEC = 10 * 60

/**
 * 新会话（或应用刚重启）还没扫描过：先拿别的会话的扫描进程最近写的共用快照顶上，任务板马上就有，
 * 不用等自己的扫描进程读完所有 transcript；第一行扫描结果到了就换掉。热重载时 $.state 里本来就有，不读。
 */
async function seedFromSnapshot($: EngineInterface) {
  if ((await read($, board)).at !== 0) return
  const home = await homeOf($)
  if (!home) return
  let got: ScanLine | null
  try {
    got = rebaseScan(JSON.parse(await $.fs.read(snapshotPath(home))), await $.clock.now(), SNAP_MAX_SEC)
  } catch {
    return // 还没有快照，或正好在换文件
  }
  if (!got) return
  const seed = got
  // 扫描进程抢先出了结果就不覆盖
  await update($, board, b => (b.at !== 0 ? b : boardFrom(seed, b)))
  await publishStatus($)
}

/** 用量文件的内容 → 读数；空的、坏的都当没有。 */
function parseUsage(text: string | undefined): Usage | undefined {
  if (!text) return undefined
  try {
    const u = JSON.parse(text) as Usage
    return typeof u.at === 'number' && Array.isArray(u.limits) ? u : undefined
  } catch {
    return undefined
  }
}

/** 本会话拿到新的额度读数：自己先显示，再写进共用文件，让别的会话的任务板也跟上。 */
async function saveUsage($: EngineInterface, limits: Usage['limits']) {
  if (limits.length === 0) return
  const u: Usage = { at: await $.clock.now(), limits: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })) }
  await update($, usage, () => u)
  const path = (await read($, board)).usagePath
  if (path) await $.fs.write(path, `${JSON.stringify(u)}
`).catch(() => undefined)
}

/** 本会话是否挂着“在等我决定”的标记（只在挂着时才去清，免得每次工具调用都写文件）。 */
let isAsking = false

/**
 * 本会话弹出授权框 / 向我提问 / MCP 表单时写标记文件（内容 = 时间毫秒），答完清空。
 * 扫描进程看到标记、且 transcript 在那之后没有新内容，就把这张卡标成 needs input。
 */
async function markInput($: EngineInterface, on: boolean) {
  if (!on && !isAsking) return
  isAsking = on
  const dir = (await read($, board)).inputDir
  const id = await read($, me)
  if (!dir || !id) return
  await $.fs.write(`${dir}/${id}`, on ? String(await $.clock.now()) : '').catch(() => undefined)
}

// ── 输入框上方的任务板（Claude 原生风格）──────────────────────────────
// 文字全用原生 Text（字体、颜色跟着 Claude 走）；每个会话一张两行的卡片，外面一个浅浅的圆角框；
// 第一行文字、第二行整宽进度线，所以每条进度线一样长；进度线和开关是很小的 SVG。

const BAND_MAX = 4
/** Claude 的橙色，开关“开”用。 */
const ACCENT = '#d97757'
/** 扁平悬停：边框加深一点、底色淡淡一层（keyed Box 的 hover，不走钩子）。 */
const HOVER = { borderDimColor: false, borderColor: '#8a877f', backgroundColor: 'rgba(138,135,127,0.10)' }
const HOVER_BG = { backgroundColor: 'rgba(138,135,127,0.12)' }
/** 本会话卡片：淡橙底；Current 标签底色稍深一点。 */
const ACCENT_TINT = 'rgba(217,119,87,0.07)'
const ACCENT_BG = 'rgba(217,119,87,0.16)'
/** 展开中的卡片和明细面板的蓝色边框；当前步骤的浅蓝底。 */
const BLUE_LINE = 'rgba(59,130,246,0.55)'
const BLUE_TINT = 'rgba(59,130,246,0.13)'
/** 明细面板里子代理最多画几行，其余汇总成一行。 */
const SUB_MAX = 3
/** 手机窄屏：Done 栏最多几张卡片、明细里步骤表最多几行（超过就折叠做完的阶段）。 */
const MOBILE_DONE_MAX = 3
const MOBILE_STEP_MAX = 6

/** 一条 3px 细进度线，宽度铺满所在的格子：中性灰轨道 + 按比例的实色填充，不做任何动画。 */
function lineSvg(frac: number, color: string) {
  const track = `<rect x="0" y="1.5" width="100%" height="3" rx="1.5" fill="#8a877f" fill-opacity=".22"/>`
  const fill =
    frac > 0 ? `<rect x="0" y="1.5" width="${Math.max(1.5, Math.min(100, frac * 100)).toFixed(2)}%" height="3" rx="1.5" fill="${color}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="6">${track}${fill}</svg>`
}

/** 43%（清单完成比例）。 */
const pct = (s: SessionRow) => percent(s.done, s.total)

/** 扁平胶囊开关：开 = 橙色轨道、白钮靠右；关 = 灰色轨道、白钮靠左。 */
function switchSvg(on: boolean) {
  const track = on
    ? `<rect width="30" height="18" rx="9" fill="${ACCENT}"/>`
    : `<rect width="30" height="18" rx="9" fill="#8a877f" fill-opacity=".45"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="18" viewBox="0 0 30 18">${track}` +
    `<circle cx="${on ? 21 : 9}" cy="9" r="7" fill="#fff"/></svg>`
  )
}

/** 一行右侧的状态字和颜色：已完成 / 闲置显示缓存倒计时，其余显示进度或状态。 */
function rowState(s: SessionRow) {
  const left = showsCache(s) ? cacheLeft(s) : null
  if (left !== null) {
    return { text: left > 0 ? cacheText(left).replace('⏱ ', '') : 'cache expired', color: cacheHex(left), frac: Math.max(0, left) / TTL_SEC }
  }
  // 在等我决定：不管有没有清单，整条黄色 + needs input，一眼看到
  if (s.status === 'input') return { text: LABEL.input, color: HEX.input, frac: 1 }
  // 有清单：百分比 + 静止进度线；没有清单的运行中会话不知道进度，只留灰轨道
  if (s.total > 0) return { text: pct(s), color: HEX[s.status], frac: s.done / s.total }
  return { text: LABEL[s.status], color: HEX[s.status], frac: s.status === 'idle' || s.status === 'running' ? 0 : 1 }
}


/** 打开 goLink 的 claude:// 链接（openArgv，平台相关）：本机的会话 Claude 应用直接切过去，别的电脑的经 Remote Control 打开。 */
async function jump($: EngineInterface, s: SessionRow) {
  const link = goLink(s)
  const remote = isRemote(s)
  if (!(remote ? link !== '' : /^claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f-]+$/.test(link))) {
    await $.ui.toast(`"${s.title}" has no link to switch to`)
    return
  }
  await $.ui.toast(remote ? `Opening "${s.title}" from ${s.device} via Remote Control…` : `Switching to "${s.title}"…`)
  try {
    const r = await $.process.run(openArgv(link))
    if (r.exitCode !== 0) await $.ui.toast(`Switch failed (exit code ${r.exitCode})`)
  } catch (err) {
    await $.ui.toast(`Switch failed: ${String(err)}`)
  }
}

// ── 下一步建议 ──────────────────────────────────────────────────────

/** 横条画过 = 这个会话有界面；claude -p、定时任务从不画，也就不 fork。 */
let bandDrawn = false

async function pick($: EngineInterface, item: Suggestion) {
  await update($, nextView, () => HIDDEN)
  try {
    const r = await $.prompt.fill({ text: item.prompt })
    if (!r.isFilled) await $.ui.toast('Could not fill the prompt box')
  } catch (err) {
    await $.ui.toast(`Could not fill the prompt box: ${String(err)}`)
  }
}

async function dismissNext($: EngineInterface) {
  await update($, nextView, () => HIDDEN)
}

const nextOn = (b: Board) => b.prefs?.nextSteps !== false

/** 发请求前现读开关文件，别的对话刚改的也算数；文件不存在 = 开。 */
async function nextEnabled($: EngineInterface) {
  const b = await read($, board)
  if (!b.prefsPath) return nextOn(b)
  try {
    const p = JSON.parse(await $.fs.read(b.prefsPath)) as Partial<Prefs> | null
    return p?.nextSteps !== false
  } catch {
    return true
  }
}

/** 全局开关：写 ~/.claude/task-board-prefs.json，所有对话的扫描进程 3 秒内读到。 */
async function toggleNext($: EngineInterface) {
  const b = await read($, board)
  if (!b.prefsPath) {
    await $.ui.toast('Task board is still starting — try again in a few seconds')
    return
  }
  const on = !nextOn(b)
  let old: Record<string, unknown> = {}
  try {
    old = JSON.parse(await $.fs.read(b.prefsPath)) as Record<string, unknown>
  } catch {
    // 还没有这个文件
  }
  try {
    await $.fs.write(b.prefsPath, `${JSON.stringify({ ...old, nextSteps: on }, null, 2)}\n`)
  } catch (err) {
    await $.ui.toast(`Could not save the switch: ${String(err)}`)
    return
  }
  await update($, board, x => ({ ...x, prefs: { ...x.prefs, nextSteps: on } }))
  if (!on) await update($, nextView, () => HIDDEN)
  await $.ui.toast(
    on
      ? 'Suggest next step on (all conversations)'
      : 'Suggest next step off (all conversations) — no extra request per turn',
  )
}

const toggleLabel = (b: Board) => (nextOn(b) ? 'Suggest next step: on' : 'Suggest next step: off')

/**
 * 隐藏 / 取消隐藏一个已完成的会话：写进同一个开关文件的 hidden（所有对话的任务板 3 秒内都读到）。
 * 记下它此刻最后一次请求的时间；之后它又有新请求或又跑起来，就自动回到任务板。
 */
async function setHidden($: EngineInterface, id: string, hide: boolean) {
  const b = await read($, board)
  const s = b.sessions.find(x => x.id === id)
  if (!b.prefsPath || (hide && !s)) {
    await $.ui.toast('Task board is still starting — try again in a few seconds')
    return
  }
  let old: Record<string, unknown> = {}
  try {
    old = JSON.parse(await $.fs.read(b.prefsPath)) as Record<string, unknown>
  } catch {
    // 还没有这个文件
  }
  const was = (old.hidden ?? {}) as Record<string, number>
  const hidden = pruneHidden({ ...was }, b.at)
  if (hide && s) hidden[id] = lastReqMs(b.at, s)
  else delete hidden[id]
  try {
    await $.fs.write(b.prefsPath, `${JSON.stringify({ ...old, hidden }, null, 2)}\n`)
  } catch (err) {
    await $.ui.toast(`Could not save: ${String(err)}`)
    return
  }
  await update($, board, x => ({ ...x, prefs: { nextSteps: x.prefs?.nextSteps !== false, hidden } }))
  if (hide && s) await $.ui.toast(`Hid "${s.title}" — it stays listed in Details`)
}

/** 输入框正上方的“下一步”区块；没有可显示的内容时返回 null。 */
/** trailing = 桌面上挂在这一块标题行最右边的东西（收起箭头），省掉单独一行，任务板不会因为太高把它挤出可见区。 */
async function nextBlock($: EngineInterface, e: Parameters<typeof $.ui.resolve>[0] & { props: { isWorking: boolean } }, trailing: RenderChildren = null) {
  const v = await read($, nextView)
  if (e.props.isWorking || v.kind === 'hidden' || !nextOn(await read($, board))) return null
  const { Box, Text, Button } = $.ui.resolve(e)

  if (v.kind === 'loading') {
    // 桌面：趁“thinking…”的这几秒，把建议的点击层先挂上（0 大小、看不见）。点击层新建后要加载一下才接得住点击，
    // 等建议出来再建，刚出现时点会没反应；同一个 key 一直在树里，引擎就沿用这个已加载好的实例
    const warm =
      e.surface === 'desktop'
        ? (() => {
            const { Client } = $.ui.resolve(e as Parameters<typeof $.ui.resolve>[0] & { surface: 'desktop' })
            return (
              <Box position="absolute" top={0} left={0} width={0} height={0} overflow="hidden">
                {[0, 1, 2].map(i => (
                  <Client key={`hit-next-${i}`} module="./hit.tsx" props={{ a: 'noop' }} width={1} height={1} />
                ))}
                <Client key="hit-dismiss" module="./hit.tsx" props={{ a: 'noop' }} width={1} height={1} />
              </Box>
            )
          })()
        : null
    return (
      <Box position="relative" marginTop={1} flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text dimColor>Suggest next step: thinking…</Text>
        {warm}
        {trailing}
      </Box>
    )
  }

  const cost = `this suggestion ${fmt(v.billed)} tok${v.cacheRead > 0 ? ` · cache read ${fmt(v.cacheRead)}` : ''}`

  if (e.surface !== 'desktop') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Suggest next step (press a number to fill the prompt box — nothing is sent) · {cost}</Text>
        {v.items.map((item, i) => (
          <Box key={`next-row-${i}`} marginLeft={2}>
            <Button key={`next-${i}`} hotkey={String(i + 1)} plain label={item.label} onPress={() => void pick($, item)} />
          </Box>
        ))}
        <Box marginLeft={2}>
          <Button key="next-dismiss" hotkey="0" plain dimColor label="Dismiss" onPress={() => void dismissNext($)} />
        </Box>
      </Box>
    )
  }

  // 桌面：扁平小卡片 + 透明点击层（Client），三处防“点了没反应”：
  //   按下就触发（不等松开：点下去输入框失焦、这块挪了位置，松开时已不在原处）；
  //   点击层在“thinking…”时就挂好了（见上面 warm），建议一出现就接得住；
  //   点击层里直接带着建议全文（t），不用点了再按序号回头查。
  // 不用原生按钮：桌面上原生按钮第一下常被拿去取得焦点，要点两次。
  const { Client } = $.ui.resolve(e as Parameters<typeof $.ui.resolve>[0] & { surface: 'desktop' })
  const hit = (key: string, a: string, t?: string) => (
    <Box position="absolute" top={0} left={0} right={0} bottom={0}>
      <Client key={key} module="./hit.tsx" props={t === undefined ? { a, down: true } : { a, t, down: true }} width="100%" height="100%" />
    </Box>
  )
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text dimColor>Suggest next step · fills the prompt box, nothing is sent · {cost}</Text>
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          <Box key="next-dismiss" position="relative" paddingX={1} hover={HOVER_BG}>
            <Text dimColor>Dismiss</Text>
            {hit('hit-dismiss', 'dismiss')}
          </Box>
          {trailing}
        </Box>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {v.items.map((item, i) => (
          <Box key={`next-${i}`} position="relative" flexDirection="row" gap={1} paddingX={1} borderStyle="round" borderDimColor hover={HOVER}>
            <Text dimColor>{i + 1}</Text>
            <Text>{item.label}</Text>
            {hit(`hit-next-${i}`, 'pick-text', item.prompt)}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

type FoldSurface = keyof Fold

/** 这台设备上任务板是不是收起的：本会话点过的为准，否则用上次的选择（所有会话共用），默认手机收起、桌面展开。 */
async function isFolded($: EngineInterface, surface: FoldSurface) {
  const own = (await read($, fold))[surface]
  if (own !== undefined) return own
  const saved = (await $.store.get('fold').catch(() => undefined)) as Fold | undefined
  return saved?.[surface] ?? surface === 'mobile'
}

/** 收起 / 展开：本会话马上生效，也记下来当以后新会话的默认。 */
async function toggleFold($: EngineInterface, surface: FoldSurface) {
  const next = !(await isFolded($, surface))
  await update($, fold, f => ({ ...f, [surface]: next }))
  const saved = ((await $.store.get('fold').catch(() => undefined)) ?? {}) as Fold
  await $.store.set('fold', { ...saved, [surface]: next }).catch(() => undefined)
}

/**
 * 任务板上的一个动作：桌面上来自透明点击层（hit.tsx）的消息，手机上来自 Button。
 * toggle / details / dismiss / show-all / collapse / x:<id> / hide:<id> / unhide:<id> / pick:<n> / go:<id> / fold:desktop|mobile
 */
async function act($: EngineInterface, a: string) {
  if (a === 'toggle') await toggleNext($)
  else if (a === 'fold:desktop' || a === 'fold:mobile') await toggleFold($, a.slice(5) as FoldSurface)
  else if (a === 'details') await $.ui.open({ id: PANE, title: TITLE })
  else if (a === 'dismiss') await dismissNext($)
  else if (a === 'show-all') await update($, showAll, x => !x)
  else if (a === 'collapse') await update($, expanded, () => '')
  else if (a.startsWith('x:')) await update($, expanded, x => (x === a.slice(2) ? '' : a.slice(2)))
  else if (a.startsWith('hide:')) await setHidden($, a.slice(5), true)
  else if (a.startsWith('unhide:')) await setHidden($, a.slice(7), false)
  else if (a.startsWith('pick:')) {
    const v = await read($, nextView)
    const item = v.kind === 'offer' ? v.items[Number(a.slice(5))] : undefined
    if (item) await pick($, item)
  } else if (a.startsWith('go:')) {
    const s = (await read($, board)).sessions.find(x => x.id === a.slice(3))
    if (s) await jump($, s)
  }
}

export const register: Register = (on, options) => {
  TTL_SEC = Math.max(1, typeof options?.cacheTtlMinutes === 'number' ? options.cacheTtlMinutes : 60) * 60
  WARN_SEC = Math.max(0, typeof options?.cacheWarnMinutes === 'number' ? options.cacheWarnMinutes : 5) * 60
  SHARED_DIR = typeof options?.sharedDir === 'string' ? options.sharedDir.trim() : DEFAULT_SHARED
  DEVICE = (typeof options?.deviceName === 'string' ? options.deviceName.trim() : '') || DEFAULT_DEVICE
  MENU_BAR = options?.menuBar !== false
  const nx = nextOptions(options)

  // 新一轮开始（打字或别的方式）就收起旧建议。
  on('turn.start', async ($, e, next) => {
    if ((await read($, nextView)).kind !== 'hidden') await update($, nextView, () => HIDDEN)
    return next(e)
  })

  // 主会话回答完：后台 fork，不拖住这一轮的结束。全局开关关着、子代理的轮次、
  // 没有界面的会话（claude -p、定时任务）都不建议，也就不多花 token。
  on('turn.complete', async ($, e, next) => {
    // 这一轮结束了，就不再是在等我决定（needs input 标记清掉）
    if (e.agentId === undefined) await markInput($, false)
    const result = await next(e)
    if (e.reason !== 'answer' || e.agentId !== undefined || e.answer.trim().length < nx.minAnswerChars) return result
    if (!bandDrawn || !(await nextEnabled($))) return result
    const turnId = e.turnId
    await update($, nextView, () => ({ kind: 'loading', turnId }) as NextView)
    void (async () => {
      let view: NextView = HIDDEN
      try {
        // 拿不到命令清单也照样建议，只是不校验斜杠命令。
        const commands = await $.command.list().catch(() => null)
        const known = commands === null ? null : new Set(commands.map(command => command.name))
        const skills = nx.suggestSkills && commands !== null ? skillList(commands) : ''
        const reply = await $.model.fork({ prompt: forkPrompt(skills) })
        const items = reply.isAnswered ? parseSuggestions(reply.text, known) : []
        if (items.length > 0) view = { kind: 'offer', items, ...costOf('usage' in reply ? reply.usage : undefined) }
      } catch (err) {
        $.ui.log(`next-steps fork failed: ${String(err)}`)
      }
      // 等待期间又开了新一轮（或另一轮先结束了）：这批作废。
      const now = await read($, nextView)
      if (now.kind !== 'loading' || now.turnId !== turnId) return
      // 等待期间开关被关了：这次已经花了，但不再显示
      if (!nextOn(await read($, board))) view = HIDDEN
      await update($, nextView, () => view)
    })()
    return result
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'task-board', description: 'Open the multi-session progress pane' })
    const id = await $.session.id()
    await update($, me, () => id)
    void seedFromSnapshot($).catch(() => undefined)
    // 没有界面的会话（claude -p、SDK 后台任务）不起扫描进程；桌面界面往往晚于 session.start 才连上，
    // 所以连上时（session.attach）和第一次要画横条时还会再补启动
    if ((await $.session.surfaces()).length > 0) {
      void watch($)
      void ensureMenubar($)
    }
    return next(e)
  })

  // ── needs input：授权框、AskUserQuestion、MCP 表单要我决定时标上，工具调用结束或这一轮结束（见下面 turn.complete）就清掉
  on('classic.PermissionRequest', async ($, e, next) => {
    await markInput($, true)
    return next(e)
  })
  on('classic.Elicitation', async ($, e, next) => {
    await markInput($, true)
    return next(e)
  })
  on('classic.ElicitationResult', async ($, e, next) => {
    await markInput($, false)
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') await markInput($, true)
    try {
      return await next(e)
    } finally {
      await markInput($, false)
    }
  })
  // 每轮回答完、或额度窗口变化满 1 个百分点时，引擎把最新的用量推过来
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await saveUsage($, e.rateLimits)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    void seedFromSnapshot($).catch(() => undefined)
    void watch($)
    void ensureMenubar($)
    // 续上的会话可能已经有用量读数了：先显示出来
    void $.session.usage().then(x => saveUsage($, x.rateLimits)).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    bandDrawn = true
    void watch($)
    // 下一步建议放在最下面，紧贴输入框（点一下就填进去）
    const steps = await nextBlock($, e)
    const b = await read($, board)
    if (b.at === 0) return steps ?? next(e)
    const self = await read($, me)
    const active = b.sessions
      .filter(s => isActive(s) && !isHidden(b.prefs, b.at, s))
      .sort((x, y) => ORDER[x.status] - ORDER[y.status] || x.ageSec - y.ageSec)
    const running = active.filter(s => s.status === 'running').length
    const tokens = active.reduce((n, s) => n + billed(s), 0)
    const shown = active.slice(0, BAND_MAX)
    const more = active.length - shown.length
    const details = {
      key: 'task-board-details',
      label: more > 0 ? `+${more} details` : 'Details',
      onPress: () => $.ui.open({ id: PANE, title: TITLE }).then(() => undefined),
    }
    const nextSwitch = { key: 'next-toggle', label: toggleLabel(b), onPress: () => toggleNext($) }
    // 收起时只剩一行：各状态的数量（在等我的排最前、黄色），右端是展开按钮
    const count = (f: (s: SessionRow) => boolean) => active.filter(f).length
    const foldParts = [
      { t: `● ${count(s => s.status === 'input')} needs input`, c: HEX.input, n: count(s => s.status === 'input') },
      { t: `● ${count(s => s.status === 'running')} running`, c: HEX.running, n: count(s => s.status === 'running') },
      { t: `● ${count(s => s.status === 'waiting')} waiting`, c: HEX.waiting, n: count(s => s.status === 'waiting') },
      { t: `● ${count(s => s.status === 'done' || s.status === 'idle')} done`, c: HEX.done, n: 1 },
    ].filter(x => x.n > 0)

    // ── 手机（Claude 手机 App 用 Remote Control 遥控这台电脑上的对话时）：窄屏单栏 ──────────────
    // 手机上没有 Client 点击层，可点的都是 Button；点卡片不跳转（跳转只会切换电脑上的桌面应用，对手机没用）。
    // 从上到下：展开的明细 → Running 标题 + 用量圆环 → 在跑的卡片 → Done 标题 → 做完的卡片 → 开关和 Details。
    if (e.surface === 'mobile') {
      const { Box, Text, Button, Svg } = $.ui.resolve(e)
      const live = active.filter(isLive).slice(0, BAND_MAX)
      const finished = active.filter(s => s.status === 'done' || s.status === 'idle').slice(0, MOBILE_DONE_MAX)
      const open = await read($, expanded)
      const openRow = live.find(s => s.id === open)
      const five = limitNow(freshest(await read($, usage), b.usage), 'five_hour', b.at)
      const hiddenN = b.sessions.filter(s => isActive(s) && isHidden(b.prefs, b.at, s)).length
      const isOn = nextOn(b)
      const tone = (state: 'done' | 'current' | 'todo') => (state === 'done' ? HEX.done : state === 'current' ? HEX.running : undefined)
      // 一次点按：在后台做，出错只记日志（不让一次失败的点按变成没人接的报错）
      const tap = (a: string) => () => void act($, a).catch(err => $.ui.log(`task-board: ${a} failed: ${String(err)}`))
      const pill = (key: string) => (
        <Text key={key} bold color={ACCENT} backgroundColor={ACCENT_BG}> Current </Text>
      )
      // 别的电脑的会话：标题前一个灰色小标签（那台电脑自己设的标签，如 Win / Mac），和 Current 同款
      const tag = (key: string, s: SessionRow) => (
        <Text key={key} bold dimColor backgroundColor={HOVER_BG.backgroundColor}>{` ${s.device} `}</Text>
      )
      // 用量圆环；收起时那一行太挤，只留百分比，不写多久重置
      const usageMini = (withReset: boolean) =>
        five && (
          <Box key="m-usage" flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
            <Svg source={ringSvg(five.pct)} alt={`Current session usage ${Math.round(five.pct)}%`} width={14} height={14} />
            <Text>
              <Text bold color={five.pct >= 80 ? ringHex(five.pct) : undefined}>{Math.round(five.pct)}%</Text>
              {withReset && five.left > 0 && <Text dimColor> · {resetIn(five.left)}</Text>}
            </Text>
          </Box>
        )

      // 收起：一行摘要 + 用量 + 右端的展开按钮（手机默认收起，不挡聊天内容）
      if (await isFolded($, 'mobile')) {
        return (
          <Box flexDirection="column">
            <Box key="m-folded" flexDirection="row" alignItems="center" gap={1}>
              <Box flexGrow={1} minWidth={0} overflow="hidden">
                <Text wrap="truncate-end">
                  {foldParts.map((x, i) => (
                    <Text key={`m-fp-${i}`} color={x.c}>{i > 0 ? '  ' : ''}{x.t}</Text>
                  ))}
                </Text>
              </Box>
              {usageMini(false)}
              <Box flexShrink={0}>
                <Button key="m-fold" plain label="▴ Board" onPress={tap('fold:mobile')} />
              </Box>
            </Box>
            {steps}
          </Box>
        )
      }

      // 卡片三行：● 标题 [Current] … 按钮 / 状态 · 用时 · 子代理 · token / 整宽进度线
      const card = (s: SessionRow, kind: 'live' | 'done') => {
        const st = rowState(s)
        const isSelf = s.id === self
        const isOpen = kind === 'live' && s.id === open
        const t = elapsed(s)
        const meta = [
          kind === 'live' && t >= 0 ? `⏱ ${clock(t)}` : '',
          kind === 'live' && s.subActive > 0 ? `${s.subActive} agent${s.subActive > 1 ? 's' : ''}` : '',
          fmt(billed(s)),
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <Box
            key={`m-row-${s.id}`}
            flexDirection="column"
            paddingX={1}
            marginTop={1}
            borderStyle="round"
            borderDimColor={!isSelf && !isOpen}
            borderColor={isSelf ? ACCENT : isOpen ? BLUE_LINE : undefined}
            backgroundColor={isSelf ? ACCENT_TINT : undefined}
          >
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Text color={HEX[s.status]}>●</Text>
              {isRemote(s) && <Box flexShrink={0}>{tag(`m-tag-${s.id}`, s)}</Box>}
              <Box flexGrow={1} minWidth={0} overflow="hidden">
                <Text wrap="truncate-end">{s.title}</Text>
              </Box>
              {isSelf && <Box flexShrink={0}>{pill(`m-pill-${s.id}`)}</Box>}
              <Box flexShrink={0}>
                {kind === 'live' ? (
                  <Button key={`m-x-${s.id}`} plain dimColor={!isOpen} label={isOpen ? '▴' : '▾'} onPress={tap(`x:${s.id}`)} />
                ) : (
                  <Button key={`m-h-${s.id}`} plain dimColor label="Hide" onPress={tap(`hide:${s.id}`)} />
                )}
              </Box>
            </Box>
            <Text wrap="truncate-end">
              <Text bold color={st.color}>{st.text}</Text>
              <Text dimColor> · {meta}</Text>
            </Text>
            <Box flexDirection="column">
              <Svg source={lineSvg(st.frac, st.color)} alt={`${s.title}: ${st.text}`} height={6} />
            </Box>
          </Box>
        )
      }

      // 子代理行：缩进，“└ ● 类型 · 模型 · 推理强度 · 工具 · 任务”，右边用时
      const subRow = (x: SubRow, key: string) => (
        <Box key={key} flexDirection="row" gap={1} paddingLeft={2}>
          <Box flexGrow={1} minWidth={0} overflow="hidden">
            <Text wrap="truncate-end">
              <Text dimColor>└ </Text>
              <Text color={x.active ? HEX.running : undefined} dimColor={!x.active}>{x.active ? '● ' : '✓ '}</Text>
              <Text bold={x.active} dimColor={!x.active}>{x.name || 'agent'}</Text>
              <Text dimColor>{` · ${[x.model ? modelName(x.model) : '', x.effort ?? '', x.active ? x.tool : '', x.desc].filter(Boolean).join(' · ')}`}</Text>
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={x.active ? HEX.running : undefined} dimColor={!x.active}>{x.active ? dur(x.sec) : `✓ ${dur(x.sec)}`}</Text>
          </Box>
        </Box>
      )
      const subRows = (list: SubRow[], key: string) => [
        ...list.slice(0, SUB_MAX).map((x, i) => subRow(x, `${key}-sub-${i}`)),
        ...(list.length > SUB_MAX
          ? [
              <Box key={`${key}-more`} paddingLeft={2}>
                <Text dimColor>└ {moreSubs(list.slice(SUB_MAX))}</Text>
              </Box>,
            ]
          : []),
      ]

      // 明细：窄屏放不下“阶段名”那一列，改成阶段名单独一行当小标题，步骤列在它下面
      const panel = (s: SessionRow) => {
        const steps = s.steps ?? []
        const stages = stagesOf(steps)
        const subs = s.subs ?? []
        const named = stages.length > 1 || (stages[0]?.name ?? '') !== ''
        const lines = stepLines(stages, MOBILE_STEP_MAX)
        const { byStep, loose } = subsByStep(subs, steps.length)
        const t = elapsed(s)
        const summary = [steps.length > 0 ? `${s.done}/${s.total} steps · ${pct(s)}` : 'no task list', t >= 0 ? `⏱ ${clock(t)}` : '']
          .filter(Boolean)
          .join(' · ')
        return (
          <Box key="m-detail" flexDirection="column" paddingX={1} marginBottom={1} borderStyle="round" borderColor={BLUE_LINE}>
            <Box flexDirection="row" alignItems="center" gap={1}>
              {isRemote(s) && <Box flexShrink={0}>{tag('m-tag-detail', s)}</Box>}
              <Box flexGrow={1} minWidth={0} overflow="hidden">
                <Text bold wrap="truncate-end">{s.title}</Text>
              </Box>
              {s.id === self && <Box flexShrink={0}>{pill('m-pill-detail')}</Box>}
              <Box flexShrink={0}>
                <Button key="m-collapse" plain dimColor label="Close" onPress={tap('collapse')} />
              </Box>
            </Box>
            <Text dimColor wrap="truncate-end">{summary}</Text>
            {lines.flatMap((ln, i) => {
              const now = ln.step?.s === 'in_progress'
              const ok = ln.step ? ln.step.s === 'completed' : ln.stage.state === 'done'
              const g = ln.stage
              const mine = (ln.step ? [ln.step] : g.steps).flatMap(x => byStep.get(x.i ?? -1) ?? [])
              const head =
                named && ln.first ? (
                  <Box key={`m-stage-${i}`} marginTop={1}>
                    <Text wrap="truncate-end">
                      <Text bold={g.state !== 'todo'} color={tone(g.state)} dimColor={g.state === 'todo'}>{g.name || 'Steps'}</Text>
                      {g.state !== 'todo' && (
                        <Text color={tone(g.state)}>{g.state === 'done' ? ` ✓ ${dur(g.sec)}` : ` ${percent(g.done, g.total)} · ${dur(g.sec)}`}</Text>
                      )}
                      {!ln.step && <Text dimColor> · {g.total} steps</Text>}
                    </Text>
                  </Box>
                ) : null
              const row = ln.step ? (
                <Box key={`m-step-${i}`} flexDirection="row" gap={1} paddingX={1} backgroundColor={now ? BLUE_TINT : undefined}>
                  <Box width={2} flexShrink={0}>
                    <Text color={ok ? HEX.done : now ? HEX.running : undefined} dimColor={!ok && !now}>{ok ? '✓' : now ? '●' : '○'}</Text>
                  </Box>
                  <Box flexGrow={1} minWidth={0} overflow="hidden">
                    <Text bold={now} dimColor={!now} wrap="truncate-end">{ln.step.t}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text color={now ? HEX.running : undefined} dimColor={!now}>
                      {ln.step.sec < 0 ? '—' : now ? `running ${dur(ln.step.sec)}` : dur(ln.step.sec)}
                    </Text>
                  </Box>
                </Box>
              ) : null
              return [head, row, ...subRows(mine, `m-step-${i}`)].filter(x => x !== null)
            })}
            <Box key="m-main" marginTop={1}>
              <Text wrap="truncate-end">
                <Text dimColor>◆ </Text>
                <Text bold dimColor>Main</Text>
                <Text dimColor> · {mainLine(s.model, s.effort, subs)}</Text>
              </Text>
            </Box>
            {subRows(loose, 'm-loose')}
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          {openRow && panel(openRow)}
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              <Text wrap="truncate-end">
                <Text bold>Running</Text>
                <Text dimColor> {live.length} · {fmt(tokens)} tok</Text>
              </Text>
            </Box>
            {usageMini(true)}
          </Box>
          {live.length === 0 ? <Text dimColor>No running sessions</Text> : live.map(s => card(s, 'live'))}
          <Box marginTop={1}>
            <Text>
              <Text bold>Done</Text>
              <Text dimColor> {finished.length} · cache left</Text>
            </Text>
          </Box>
          {finished.length === 0 ? <Text dimColor>None</Text> : finished.map(s => card(s, 'done'))}
          {/* 最后一行：左边开关和 Details，右下角是收起按钮 */}
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} marginTop={1}>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2} flexShrink={1} minWidth={0}>
              <Button key="m-next" plain dimColor={!isOn} label={`Next step: ${isOn ? 'On' : 'Off'}`} onPress={tap('toggle')} />
              <Button key="m-details" plain dimColor label={`Details${hiddenN > 0 ? ` · ${hiddenN} hidden` : ''}`} onPress={tap('details')} />
            </Box>
            <Box flexShrink={0}>
              <Button key="m-fold" plain label="▾ Hide" onPress={tap('fold:mobile')} />
            </Box>
          </Box>
          {steps}
        </Box>
      )
    }

    if (e.surface !== 'desktop') {
      const { Box, Text, Button } = $.ui.resolve(e)
      const tag = (s: SessionRow) => {
        const left = showsCache(s) ? cacheLeft(s) : null
        if (left !== null) return cacheText(left)
        return s.total > 0 && s.status !== 'input' ? `${Math.round((s.done / s.total) * 100)}%` : LABEL[s.status]
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={2}>
            <Text dimColor>{running} running · {fmt(tokens)} tok</Text>
            {shown.map(s => (
              <Text color={COLOR[s.status]}>
                ● {fit(s.title, 12).trim()} {tag(s)}
              </Text>
            ))}
            <Button {...details} />
            <Button {...nextSwitch} dimColor />
          </Box>
          {steps}
        </Box>
      )
    }

    // 两栏：左栏正在跑（运行中 / 待处理），右栏已完成；每个会话一行、一个浅框，整行可点跳到该会话
    const { Box, Text, Svg, Client } = $.ui.resolve(e)
    const hit = (key: string, a: string) => (
      <Box position="absolute" top={0} left={0} right={0} bottom={0}>
        <Client key={key} module="./hit.tsx" props={{ a }} width="100%" height="100%" />
      </Box>
    )
    // 收起：一行摘要 + 用量 + 右端的展开箭头；这一行放在最底下（下一步建议在它上面），箭头永远在最右下角
    if (await isFolded($, 'desktop')) {
      const five = limitNow(freshest(await read($, usage), b.usage), 'five_hour', b.at)
      return (
        <Box flexDirection="column">
          {steps}
          <Box key="folded" flexDirection="row" alignItems="center" gap={2} marginTop={steps ? 1 : 0}>
            <Box flexGrow={1} minWidth={0} overflow="hidden">
              <Text wrap="truncate-end">
                <Text bold>Task board</Text>
                {foldParts.map((x, i) => (
                  <Text key={`fp-${i}`} color={x.c}>{'   '}{x.t}</Text>
                ))}
              </Text>
            </Box>
            {five && (
              <Box key="folded-usage" flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                <Svg source={ringSvg(five.pct)} alt={`Current session usage ${Math.round(five.pct)}%`} width={16} height={16} />
                <Text>
                  <Text dimColor>Session </Text>
                  <Text bold color={five.pct >= 80 ? ringHex(five.pct) : undefined}>{Math.round(five.pct)}%</Text>
                </Text>
              </Box>
            )}
            <Box key="fold-btn" position="relative" flexShrink={0} hover={HOVER_BG}>
              <Svg source={foldSvg(true)} alt="Show the task board" width={16} height={16} />
              {hit('hit-fold', 'fold:desktop')}
            </Box>
          </Box>
        </Box>
      )
    }
    const live = active.filter(isLive).slice(0, BAND_MAX)
    const finished = active.filter(s => s.status === 'done' || s.status === 'idle').slice(0, BAND_MAX)
    const isOn = nextOn(b)
    const open = await read($, expanded)
    const openRow = live.find(s => s.id === open)

    // 本会话：橙色边框 + 淡橙底 + 标题后 Current 小标签，一眼认出“我在哪个卡片”
    // 一段带底色的文字（不是带内边距的 Box），和标题同一行高，不撑高卡片
    const pill = (key: string) => (
      <Text key={key} bold color={ACCENT} backgroundColor={ACCENT_BG}> Current </Text>
    )
    // 别的电脑的会话：标题前一个灰色小标签（那台电脑自己设的标签，如 Win / Mac），和 Current 同款；点了经 Remote Control 打开，没有编号的不挂点击层
    const tag = (key: string, s: SessionRow) => (
      <Text key={key} bold dimColor backgroundColor={HOVER_BG.backgroundColor}>{` ${s.device} `}</Text>
    )

    // 每张卡片两行（和 Details 窗一样）：
    //   第一行 = 状态点 + 标题（占满剩下的宽度，放不下才省略）+ 右侧状态文字（整段显示、不换行）+ 小图标按钮
    //   第二行 = 整宽进度线，不再跟文字抢宽度
    // 文字区和进度线点了跳到该会话；图标按钮有自己的点击层，两者不重叠。
    const row = (s: SessionRow, kind: 'live' | 'done') => {
      const st = rowState(s)
      const isSelf = s.id === self
      const isOpen = kind === 'live' && s.id === open
      const t = elapsed(s)
      return (
        <Box
          key={`row-${s.id}`}
          flexDirection="column"
          // 带边框的 Box 桌面上会自动加约 10px 的上下内边距；显式给 0.5 行单位（约 5px）盖掉它
          paddingY={0.5}
          paddingX={1}
          marginTop={1}
          width="100%"
          borderStyle="round"
          borderDimColor={!isSelf && !isOpen}
          borderColor={isSelf ? ACCENT : isOpen ? BLUE_LINE : undefined}
          backgroundColor={isSelf ? ACCENT_TINT : undefined}
          hover={isSelf || !canOpen(s) ? undefined : HOVER}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box position="relative" flexDirection="row" alignItems="center" gap={1} flexGrow={1} minWidth={0}>
              <Text color={HEX[s.status]}>●</Text>
              <Box flexDirection="row" alignItems="center" gap={1} flexGrow={1} minWidth={0}>
                {isRemote(s) && <Box flexShrink={0}>{tag(`tag-${s.id}`, s)}</Box>}
                <Text wrap="truncate-end">{s.title}</Text>
                {isSelf && (
                  <Box flexShrink={0}>
                    {pill(`pill-${s.id}`)}
                  </Box>
                )}
              </Box>
              <Box flexShrink={0}>
                <Text wrap="truncate-end">
                  <Text bold color={st.color}>{st.text}</Text>
                  {kind === 'live' && t >= 0 && <Text dimColor> · ⏱ {clock(t)}</Text>}
                  {kind === 'live' && s.subActive > 0 && <Text dimColor> · {s.subActive} agent{s.subActive > 1 ? 's' : ''}</Text>}
                  <Text dimColor> · {fmt(billed(s))}</Text>
                </Text>
              </Box>
              {!isSelf && canOpen(s) && hit(`go-${s.id}`, `go:${s.id}`)}
            </Box>
            {kind === 'live' ? (
              <Box key={`xb-${s.id}`} position="relative" flexShrink={0} hover={HOVER_BG}>
                <Svg source={chevronSvg(isOpen)} alt={isOpen ? 'Hide details' : 'Show details'} width={16} height={16} />
                {hit(`x-${s.id}`, `x:${s.id}`)}
              </Box>
            ) : (
              <Box key={`hb-${s.id}`} position="relative" flexShrink={0} hover={HOVER_BG}>
                <Svg source={eyeOffSvg()} alt="Hide from board" width={16} height={16} />
                {hit(`h-${s.id}`, `hide:${s.id}`)}
              </Box>
            )}
          </Box>
          {/* 纵向排列的 Box 会把里面的 Svg 图片拉满整宽（横向排列时图片只有默认宽度） */}
          <Box position="relative" flexDirection="column">
            <Svg source={lineSvg(st.frac, st.color)} alt={`${s.title}: ${st.text}`} height={6} />
            {!isSelf && canOpen(s) && hit(`go2-${s.id}`, `go:${s.id}`)}
          </Box>
        </Box>
      )
    }

    // 明细面板：跨两栏、放在最上面，从上到下四块：
    //   标题行   = 标题 + Current + 摘要 + Collapse
    //   阶段条   = 每个阶段一样宽的一格：细进度线 + 一行“名字 状态”，放不下就截断（只做总览，不放步骤）
    //   步骤表   = 每步一行、四列对齐：状态图标 | 阶段名（每个阶段只在第一行写）| 步骤标题（截断）| 耗时（不换行）
    //   子代理行 = 跟在派它出去的那一步下面，缩进到标题列
    //   Main 行  = 主会话的模型 · 推理强度 · 这一轮有没有子代理（没有也写出来），不属于任何一步的子代理列在它下面
    // 桌面上横排的 Box 默认最小宽度 = 内容宽度，长文字会把格子撑开、盖到旁边：
    // 要截断的格子一律 minWidth={0} + overflow="hidden"，图标和耗时 flexShrink={0}，所以既不重叠也不换行。
    const panel = (s: SessionRow) => {
      const steps = s.steps ?? []
      const stages = stagesOf(steps)
      const subs = s.subs ?? []
      const t = elapsed(s)
      const running = subs.filter(x => x.active).length
      const summary = [
        steps.length > 0 ? `${s.done}/${s.total} steps · ${pct(s)}` : 'no task list',
        t >= 0 ? `⏱ ${clock(t)} ${planOpen(s) ? 'total' : 'this turn'}` : '',
        running > 0 ? `${running} subagent${running > 1 ? 's' : ''} running` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const named = stages.length > 1 || (stages[0]?.name ?? '') !== ''
      // 阶段名一列的宽度：最长的阶段名，最多 14 格（中文一个字算两格）
      const labelW = Math.min(14, Math.max(4, ...stages.map(g => width(g.name)))) + 1
      const stageW = `${Math.floor(100 / Math.max(1, stages.length))}%`
      const lines = stepLines(stages)
      const tone = (state: 'done' | 'current' | 'todo') => (state === 'done' ? HEX.done : state === 'current' ? HEX.running : undefined)
      const { byStep, loose } = subsByStep(subs, steps.length)
      // 子代理行：缩进到标题那一列，“└ ● 类型 · 模型 · 推理强度 · 正在用的工具 · 任务”，后面是调用次数和耗时；
      // 每组最多 SUB_MAX 行，其余汇总成一行
      const subRows = (list: SubRow[], key: string) => [
        ...list.slice(0, SUB_MAX).map((x, i) => (
          <Box key={`${key}-sub-${i}`} flexDirection="row" alignItems="center" gap={1} paddingX={1}>
            <Box width={2} flexShrink={0} />
            {named && <Box width={labelW} flexShrink={0} />}
            <Box flexGrow={1} minWidth={0} overflow="hidden">
              <Text wrap="truncate-end">
                <Text dimColor>└ </Text>
                <Text color={x.active ? HEX.running : undefined} dimColor={!x.active}>{x.active ? '● ' : '✓ '}</Text>
                <Text bold={x.active} dimColor={!x.active}>{x.name || 'agent'}</Text>
                <Text dimColor>{` · ${[x.model ? modelName(x.model) : '', x.effort ?? '', x.active ? x.tool : '', x.desc].filter(Boolean).join(' · ')}`}</Text>
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{(x.calls ?? 0) === 1 ? '1 call' : `${x.calls ?? 0} calls`}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={x.active ? HEX.running : undefined} dimColor={!x.active}>
                {x.active ? dur(x.sec) : `✓ ${dur(x.sec)}`}
              </Text>
            </Box>
          </Box>
        )),
        ...(list.length > SUB_MAX
          ? [
              <Box key={`${key}-more`} flexDirection="row" gap={1} paddingX={1}>
                <Box width={2} flexShrink={0} />
                {named && <Box width={labelW} flexShrink={0} />}
                <Text>
                  <Text dimColor>└ </Text>
                  <Text dimColor>{moreSubs(list.slice(SUB_MAX))}</Text>
                </Text>
              </Box>,
            ]
          : []),
      ]
      return (
        <Box key="detail" flexDirection="column" paddingX={1} marginBottom={1} borderStyle="round" borderColor={BLUE_LINE}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {isRemote(s) && <Box key="tag-detail" flexShrink={0}>{tag('tag-detail-text', s)}</Box>}
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              <Text bold wrap="truncate-end">{s.title}</Text>
            </Box>
            {s.id === self && <Box flexShrink={0}>{pill('pill-detail')}</Box>}
            <Box flexGrow={1} minWidth={0} overflow="hidden">
              <Text dimColor wrap="truncate-end">{summary}</Text>
            </Box>
            <Box key="detail-collapse" position="relative" flexShrink={0} paddingX={1} hover={HOVER_BG}>
              <Text dimColor>Collapse</Text>
              {hit('hit-collapse', 'collapse')}
            </Box>
          </Box>
          {named && (
            <Box flexDirection="row" gap={1} marginTop={1}>
              {stages.map((g, gi) => (
                <Box key={`stage-${gi}`} flexDirection="column" width={stageW} flexShrink={1} minWidth={0} overflow="hidden">
                  <Svg source={segSvg(g.state, g.done, g.total)} alt={`${g.name}: ${g.done}/${g.total}`} height={4} />
                  <Text wrap="truncate-end">
                    <Text bold={g.state !== 'todo'} color={tone(g.state)} dimColor={g.state === 'todo'}>{g.name || 'Steps'}</Text>
                    {g.state !== 'todo' && (
                      <Text color={tone(g.state)}>{g.state === 'done' ? ` ✓ ${dur(g.sec)}` : ` ${percent(g.done, g.total)} · ${dur(g.sec)}`}</Text>
                    )}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
          {lines.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {lines.map((ln, i) => {
                const now = ln.step?.s === 'in_progress'
                const ok = ln.step ? ln.step.s === 'completed' : ln.stage.state === 'done'
                const time = ln.step
                  ? ln.step.sec < 0 ? '—' : now ? `running ${dur(ln.step.sec)}` : dur(ln.step.sec)
                  : ln.stage.state === 'done' ? dur(ln.stage.sec) : '—'
                // 这一步（折起来的阶段 = 阶段里所有步）派出去的子代理，紧跟在这一行下面
                const mine = (ln.step ? [ln.step] : ln.stage.steps).flatMap(x => byStep.get(x.i ?? -1) ?? [])
                return [
                  <Box key={`step-${i}`} flexDirection="row" alignItems="center" gap={1} paddingX={1} backgroundColor={now ? BLUE_TINT : undefined}>
                    {/* 图标列定宽：✓ ● ○ 字宽不一样，不定宽后面的列会错开 */}
                    <Box width={2} flexShrink={0}>
                      <Text color={ok ? HEX.done : now ? HEX.running : undefined} dimColor={!ok && !now}>{ok ? '✓' : now ? '●' : '○'}</Text>
                    </Box>
                    {named && (
                      <Box width={labelW} flexShrink={0} minWidth={0} overflow="hidden">
                        <Text bold={ln.first && ln.stage.state === 'current'} color={ln.stage.state === 'current' ? HEX.running : undefined} dimColor={ln.stage.state !== 'current'} wrap="truncate-end">
                          {ln.first ? ln.stage.name || 'Steps' : ''}
                        </Text>
                      </Box>
                    )}
                    <Box flexGrow={1} minWidth={0} overflow="hidden">
                      <Text bold={now} dimColor={!now} wrap="truncate-end">
                        {ln.step ? ln.step.t : `${ln.stage.total} steps`}
                      </Text>
                    </Box>
                    <Box flexShrink={0}>
                      <Text color={now ? HEX.running : undefined} dimColor={!now}>{time}</Text>
                    </Box>
                  </Box>,
                  ...subRows(mine, `step-${i}`),
                ]
              })}
            </Box>
          )}
          {/* 谁在干活：主会话的模型和推理强度，这一轮有没有子代理；不属于任何一步的子代理列在它下面 */}
          <Box flexDirection="column" marginTop={lines.length > 0 || named ? 1 : 0}>
            <Box key="agents-main" flexDirection="row" alignItems="center" gap={1} paddingX={1}>
              <Box width={2} flexShrink={0}>
                <Text dimColor>◆</Text>
              </Box>
              <Box width={named ? labelW : undefined} flexShrink={0}>
                <Text bold dimColor>Main</Text>
              </Box>
              <Box flexGrow={1} minWidth={0} overflow="hidden">
                <Text dimColor wrap="truncate-end">{mainLine(s.model, s.effort, subs)}</Text>
              </Box>
            </Box>
            {subRows(loose, 'loose')}
          </Box>
        </Box>
      )
    }

    // 扁平胶囊开关：文字 + On/Off + 小滑块，整块可点（透明点击层盖在上面）
    const toggle = (
      <Box key="next-switch" position="relative" flexDirection="row" alignItems="center" gap={1} paddingX={1} paddingY={0.5} borderStyle="round" borderDimColor flexShrink={0}>
        <Text bold wrap="truncate-end">Next step</Text>
        <Text color={isOn ? ACCENT : undefined} dimColor={!isOn}>{isOn ? "On" : "Off"}</Text>
        <Svg source={switchSvg(isOn)} alt={isOn ? 'Suggest next step is on' : 'Suggest next step is off'} width={30} height={18} />
        {hit('next-toggle', 'toggle')}
      </Box>
    )

    const hiddenN = b.sessions.filter(s => isActive(s) && isHidden(b.prefs, b.at, s)).length

    // 账号 5 小时额度（设置页 Usage 里的 Current session）：小圆环 + 百分比 + 离重置多久，靠 Running 标题行右侧
    const u = freshest(await read($, usage), b.usage)
    const five = limitNow(u, 'five_hour', b.at)
    const week = limitNow(u, 'seven_day', b.at)
    const ring = five && (
      <Box key="usage-ring" flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        <Svg
          source={ringSvg(five.pct)}
          alt={`Current session usage ${Math.round(five.pct)}%${week ? `, weekly ${Math.round(week.pct)}%` : ''}`}
          width={16}
          height={16}
        />
        <Text>
          <Text dimColor>Session </Text>
          <Text bold color={five.pct >= 80 ? ringHex(five.pct) : undefined}>{Math.round(five.pct)}%</Text>
          {five.left > 0 && <Text dimColor> · resets in {resetIn(five.left)}</Text>}
        </Text>
      </Box>
    )

    const foldBtn = (
      <Box key="fold-btn" position="relative" flexShrink={0} hover={HOVER_BG}>
        <Svg source={foldSvg(false)} alt="Collapse the task board" width={16} height={16} />
        {hit('hit-fold', 'fold:desktop')}
      </Box>
    )
    const tail = await nextBlock($, e, foldBtn)

    return (
      <Box flexDirection="column">
        {openRow && panel(openRow)}
        {/* 两栏的标题放同一行（右边有开关、更高，左边跟着撑到一样高、文字居中），卡片另起一行，左右第一张卡顶部对齐。
            窗口窄时（Mac 的输入框比 Windows 窄一些）开关、Details、用量圆环不压缩、不换行，标题文字被挤时截断 */}
        <Box flexDirection="row" gap={3}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} width="50%" minWidth={0}>
            {/* 标题和后面的说明是两个同级 Text（嵌在一个 Text 里时内层照样换行）：说明那段单独放在可截断的盒子里 */}
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text bold>Running</Text>
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Text dimColor wrap="truncate-end">{live.length} · {fmt(tokens)} tok</Text>
              </Box>
            </Box>
            {ring}
          </Box>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} width="50%" minWidth={0}>
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text bold>Done</Text>
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Text dimColor wrap="truncate-end">{finished.length} · cache left</Text>
              </Box>
            </Box>
            {/* 开关不压缩；Details 可以让位（被挤时截断），把宽度留给 cache left */}
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
              {toggle}
              <Box key="details-link" position="relative" paddingX={1} hover={HOVER_BG} flexShrink={1} minWidth={0} overflow="hidden">
                <Text dimColor wrap="truncate-end">{details.label}{hiddenN > 0 ? ` · ${hiddenN} hidden` : ''}</Text>
                {hit('hit-details', 'details')}
              </Box>
            </Box>
          </Box>
        </Box>
        <Box flexDirection="row" gap={3}>
          <Box flexDirection="column" width="50%">
            {live.length === 0 ? <Text dimColor>No running sessions</Text> : live.map(s => row(s, 'live'))}
          </Box>
          <Box flexDirection="column" width="50%">
            {finished.length === 0 ? <Text dimColor>None</Text> : finished.map(s => row(s, 'done'))}
          </Box>
        </Box>
        {/* 收起箭头：有下一步建议时挂在建议标题行最右边（不多占一行，免得任务板太高把它挤出可见区）；
            没有建议时单独一行在最右下角，上面留半行，别贴着任务卡 */}
        {tail ?? (
          <Box flexDirection="row" justifyContent="flex-end" marginTop={0.5}>
            {foldBtn}
          </Box>
        )}
      </Box>
    )
  })

  // 桌面上所有可点的东西都是透明点击层（hit.tsx）发来的消息
  on('ui.message', async ($, e, next) => {
    if (!e.module.endsWith('hit.tsx')) return next(e)
    const data = (e.data ?? {}) as { a?: unknown; t?: unknown }
    const a = data.a
    if (a === 'pick-text' && typeof data.t === 'string') await pick($, { label: '', prompt: data.t })
    else if (typeof a === 'string' && a !== 'noop') await act($, a)
    return {}
  })

  on('command.run', { command: 'task-board' }, async $ => {
    await update($, board, x => ({ ...x, error: undefined }))
    void watch($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Session pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    void watch($)
    const b = await read($, board)
    const self = await read($, me)
    const all = await read($, showAll)
    const shown = all ? b.sessions : b.sessions.filter(isActive)
    const hidden = b.sessions.length - shown.length
    const list = [...shown].sort((x, y) => ORDER[x.status] - ORDER[y.status] || x.ageSec - y.ageSec)
    const running = list.filter(s => s.status === 'running').length
    const total = list.reduce((n, s) => n + billed(s), 0)
    const summary = `${list.length} sessions · ${running} running · ${fmt(total)} tok total`
    const scope = all
      ? 'All sessions in the last 24 h'
      : `Active only (running, waiting, or last request within ${ACTIVE_SEC / 60} min with cache still warm)${hidden ? ` · ${hidden} hidden` : ''}`
    const toggle = { key: 'toggle', label: all ? 'Active only' : 'Show all', onPress: () => update($, showAll, x => !x) }
    const nextSwitch = { key: 'pane-next-toggle', label: toggleLabel(b), onPress: () => toggleNext($) }
    const notice = b.error ?? (b.at === 0 ? 'Reading session logs…' : '')

    const hiddenOn = (s: SessionRow) => isHidden(b.prefs, b.at, s)
    const subtitle = (s: SessionRow) => {
      const left = showsCache(s) ? cacheLeft(s) : null
      return [
        s.id === self ? 'this session' : '',
        hiddenOn(s) ? 'hidden from board' : '',
        s.project,
        s.current ? `▸ ${s.current}` : '',
        s.subActive ? `${s.subActive} subagents running` : s.subagents ? `${s.subagents} subagents` : '',
        ago(s.ageSec),
        left === null ? '' : left > 0 ? `cache ${cacheText(left).replace('⏱ ', '')} left` : 'cache expired',
      ]
        .filter(Boolean)
        .join(' · ')
    }
    const right = (s: SessionRow) =>
      s.total > 0 && s.status !== 'input' ? `${Math.round((s.done / s.total) * 100)}% · ${s.done}/${s.total}` : LABEL[s.status]

    // 桌面：扁平风格，开关和“显示全部”是带悬停的扁平控件，整行可点跳到该会话（透明点击层）
    if (e.surface === 'desktop') {
      const { Box, Text, Svg, Client } = $.ui.resolve(e)
      const isOn = nextOn(b)
      const hit = (key: string, a: string) => (
        <Box position="absolute" top={0} left={0} right={0} bottom={0}>
          <Client key={key} module="./hit.tsx" props={{ a }} width="100%" height="100%" />
        </Box>
      )
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
            <Text bold>{summary}</Text>
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
              <Box key="pane-switch" position="relative" flexDirection="row" alignItems="center" gap={1} paddingX={1} borderStyle="round" borderDimColor>
                <Text bold>Next step</Text>
                <Text color={isOn ? ACCENT : undefined} dimColor={!isOn}>{isOn ? 'On' : 'Off'}</Text>
                <Svg source={switchSvg(isOn)} alt={isOn ? 'Suggest next step is on' : 'Suggest next step is off'} width={30} height={18} />
                {hit('pane-next-toggle', 'toggle')}
              </Box>
              <Box key="pane-show" position="relative" paddingX={1} hover={HOVER_BG}>
                <Text dimColor>{all ? 'Active only' : 'Show all'}</Text>
                {hit('hit-show', 'show-all')}
              </Box>
            </Box>
          </Box>
          <Text dimColor>{scope} · token = input + cache write + output</Text>
          {notice !== '' && <Text color={b.error ? 'red' : undefined} dimColor={!b.error}>{notice}</Text>}
          {list.map(s => {
            const isSelf = s.id === self
            const canGo = goLink(s) !== '' && !isSelf
            const hid = hiddenOn(s)

            const frac = s.status === 'input' ? 1 : s.total > 0 ? s.done / s.total : s.status === 'done' || s.status === 'waiting' ? 1 : 0
            // 三行：标题 + 标签 + 右侧状态 / 副标题 / 整宽进度线。进度线每行一样长，窄的时候也不会被挤掉
            return (
              <Box
                key={`pane-row-${s.id}`}
                flexDirection="column"
                marginTop={1}
                paddingX={1}
                borderStyle="round"
                borderDimColor={!isSelf}
                borderColor={isSelf ? ACCENT : undefined}
                backgroundColor={isSelf ? ACCENT_TINT : undefined}
                hover={canGo ? HOVER : undefined}
              >
                <Box flexDirection="row" alignItems="center" gap={1}>
                  <Box position="relative" flexDirection="row" alignItems="center" gap={1} flexGrow={1}>
                    {isRemote(s) && (
                      <Box flexShrink={0} paddingX={1} backgroundColor={HOVER_BG.backgroundColor}>
                        <Text bold dimColor>{s.device}</Text>
                      </Box>
                    )}
                    <Box flexShrink={1}>
                      <Text bold dimColor={hid} wrap="truncate-end">{s.title}</Text>
                    </Box>
                    {isSelf && (
                      <Box flexShrink={0} paddingX={1} backgroundColor={ACCENT_BG}>
                        <Text bold color={ACCENT}>Current</Text>
                      </Box>
                    )}
                    {hid && (
                      <Box flexShrink={0} paddingX={1} backgroundColor={HOVER_BG.backgroundColor}>
                        <Text dimColor>Hidden</Text>
                      </Box>
                    )}
                    <Box flexGrow={1} />
                    <Box flexShrink={0}>
                      <Text>
                        <Text>{right(s)}</Text>
                        <Text dimColor> · {fmt(billed(s))} tok</Text>
                      </Text>
                    </Box>
                    {canGo && hit(`pane-go-${s.id}`, `go:${s.id}`)}
                  </Box>
                  {hid && (
                    <Box key={`pane-unhide-${s.id}`} position="relative" flexShrink={0} paddingX={1} hover={HOVER_BG}>
                      <Text color={HEX.running}>Unhide</Text>
                      {hit(`hit-unhide-${s.id}`, `unhide:${s.id}`)}
                    </Box>
                  )}
                </Box>
                <Box position="relative" flexDirection="column">
                  <Text dimColor wrap="truncate-end">{subtitle(s)}</Text>
                  <Svg source={lineSvg(frac, HEX[s.status])} alt={`${s.title}: ${right(s)}`} height={6} />
                  {canGo && hit(`pane-go2-${s.id}`, `go:${s.id}`)}
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }

    // 编辑器 / 手机（没有 Client）：仿用量页的细圆角进度条，普通按钮
    if (e.surface !== 'terminal') {
      const { Box, Text, Svg, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text bold>{summary}</Text>
            <Box flexDirection="row" gap={1}>
              <Button {...nextSwitch} />
              <Button {...toggle} />
            </Box>
          </Box>
          <Text dimColor>{scope} · token = input + cache write + output</Text>
          {notice !== '' && <Text color={b.error ? 'red' : undefined} dimColor={!b.error}>{notice}</Text>}
          {list.map(s => (
            <Box key={s.id} flexDirection="row" alignItems="center" marginTop={1} gap={2}>
              <Box flexDirection="column" width="30%" flexShrink={0}>
                <Text bold wrap="truncate-end">{s.title}</Text>
                <Text dimColor wrap="truncate-end">{subtitle(s)}</Text>
              </Box>
              <Box flexGrow={1} flexDirection="column">
                <Svg source={barSvg(s)} alt={`${s.title}: ${right(s)}`} />
              </Box>
              <Box flexDirection="column" alignItems="flex-end" width="16%" flexShrink={0}>
                <Text>{right(s)}</Text>
                <Text dimColor>{fmt(billed(s))} tok</Text>
              </Box>
              {goLink(s) !== '' && s.id !== self && (
                <Button key={`pane-go-${s.id}`} label="↗" plain dimColor onPress={() => void jump($, s)} />
              )}
              {hiddenOn(s) && (
                <Button key={`pane-unhide-${s.id}`} label="Unhide" plain onPress={() => void setHidden($, s.id, false)} />
              )}
            </Box>
          ))}
        </Box>
      )
    }

    // 终端：字符画进度条
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(40, e.viewport?.columns ?? 80)
    const titleCols = Math.min(24, Math.max(12, Math.floor(cols * 0.28)))
    const barCols = Math.max(8, cols - titleCols - 28)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text bold>{summary}</Text>
          <Button {...toggle} />
          <Button {...nextSwitch} />
        </Box>
        <Text dimColor>{scope}</Text>
        {notice !== '' && <Text dimColor>{notice}</Text>}
        {list.map(s => (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Text bold>{fit(isRemote(s) ? `${s.device} · ${s.title}` : s.title, titleCols)} </Text>
              <Text color={COLOR[s.status]}>{bar(s, barCols)}</Text>
              <Text> {fit(right(s), 14)}</Text>
              <Text>{fmt(billed(s)).padStart(8)}</Text>
            </Box>
            <Text dimColor>{'  ' + subtitle(s)}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
