/** input = 在等我决定（授权框、提问、MCP 表单）；waiting = 停在工具调用上但不需要我（多半是命令跑得久） */
export type SessionStatus = 'input' | 'running' | 'waiting' | 'done' | 'idle'

export type SessionRow = {
  id: string
  title: string
  link: string
  /** 这个会话的 Remote Control 编号（桌面应用元数据 bridgeSessionIds 的最后一个，session_…）：别的电脑点这张卡时打开 claude://claude.ai/code/<编号>；没有 = '' */
  bridge?: string
  project: string
  status: SessionStatus
  ageSec: number
  /** 距主 transcript 最后一次 API 请求多少秒（提示缓存从那一刻起算）；-1 = 还没有请求 */
  cacheAgeSec: number
  done: number
  total: number
  current: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  subagents: number
  subActive: number
  /** 任务清单的每一步；sec = 耗时秒数（进行中 = 已进行多久，未开始 = -1） */
  steps?: Step[]
  /** 任务清单总耗时（第一步建立起到现在或到最后一步完成）；没有清单 = -1 */
  planSec?: number
  /** 这一轮用户提问到现在多少秒；-1 = 不知道 */
  turnSec?: number
  /** 子代理明细：正在跑的，和这一轮里跑完的 */
  subs?: SubRow[]
  /** 主会话自己用的模型和推理强度（最后一次回答的）；读不到为 null */
  model?: string | null
  effort?: string | null
  /** 别的电脑上的会话（经共享目录读到）：device = 那台电脑的标签（设置项 deviceName，也是它在共享目录里的文件名），os = win / mac；本机的会话没有这两个字段 */
  device?: string
  os?: string
}

export type StepStatus = 'pending' | 'in_progress' | 'completed'
/** i = 在会话步骤列表里的序号（分阶段后用来对上子代理是哪一步派出去的） */
export type Step = { t: string; s: StepStatus | string; sec: number; i?: number }
/** effort = 推理强度（low / medium / high / xhigh / max，模型不支持时为空）；calls = 已调用工具次数 */
export type SubRow = {
  name: string
  desc: string
  model: string
  tool: string
  sec: number
  active: boolean
  effort?: string
  calls?: number
  /** 哪一步派出去的：在 steps 里的序号；-1 / 没有 = 不在任何一步里 */
  step?: number
}

/** 全局开关（~/.claude/task-board-prefs.json，所有会话共用）；文件不存在 = 默认值 */
export type Prefs = {
  nextSteps: boolean
  /** 手动隐藏的已完成会话：会话 id → 隐藏时它最后一次请求的时间（毫秒）。之后又有新请求就自动回来 */
  hidden?: Record<string, number>
}

export type Board = {
  at: number
  tick: number
  sessions: SessionRow[]
  error?: string
  prefs?: Prefs
  /** 开关文件的绝对路径，由扫描进程给出 */
  prefsPath?: string
  /** 账号用量文件（所有会话共用）的路径，和它里面最新的读数 */
  usagePath?: string
  usage?: Usage
  /** “在等我决定”标记文件所在的目录（每个会话一个文件，文件名 = 会话 id），由扫描进程给出 */
  inputDir?: string
}

/** 扫描进程输出的一行（也是共用快照 ~/.claude/task-board-snapshot.json 的内容）；usageText = 用量文件原文 */
export type ScanLine = Pick<Board, 'at' | 'sessions' | 'prefs' | 'prefsPath' | 'usagePath' | 'inputDir'> & {
  usageText?: string
  /** 本机标签（设置项 deviceName；共享目录里的文件名）和系统（win / mac） */
  device?: string
  os?: string
  /** 共享目录里其他设备的快照，扫描进程原样附上（各自带 device / os / at），由 plan.ts 的 mergeRemote 并入 */
  remote?: ScanLine[]
}

/** 一个额度窗口：five_hour = 设置页 Usage 里的 Current session，seven_day = 每周额度 */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
/** 一次用量读数：at = 读到的时间（毫秒） */
export type Usage = { at: number; limits: Limit[] }

/** 任务板收起了没有，按设备分开记：true = 收起成一行；没记过的用默认（手机收起、桌面展开） */
export type Fold = { desktop?: boolean; mobile?: boolean }

export type Suggestion = { label: string; prompt: string }

export type NextView =
  | { kind: 'hidden' }
  | { kind: 'loading'; turnId: string }
  | { kind: 'offer'; items: Suggestion[]; billed: number; cacheRead: number }

declare module 'claude-code' {
  interface PluginState {
    /** expanded = Running 栏里展开了明细的会话 id（'' = 都收起）；usage = 本会话自己最近一次读到的账号用量；fold = 任务板收起了没有 */
    'task-board': { board: Board; me: string; showAll: boolean; next: NextView; expanded: string; usage: Usage; fold: Fold }
  }
}
