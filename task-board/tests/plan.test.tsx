import { expect, mock, test } from 'claude-code/testing'

import { clock, dur, elapsed, foldSvg, freshest, isHidden, limitNow, mainLine, mergeRemote, modelName, percent, rebaseScan, resetIn, ringSvg, segSvg, splitStage, stagesOf, stepLines, subsByStep } from '../hooks/plan'

test('阶段：按 “阶段名: 步骤名” 分组，没前缀的跟上一个阶段，全无前缀 = 一个阶段', async () => {
  const g = stagesOf([
    { t: 'Survey: Read notes', s: 'completed', sec: 130 },
    { t: 'Survey：Probe schema', s: 'completed', sec: 330 },
    { t: 'Renumber: Set prefix', s: 'completed', sec: 192 },
    { t: 'Renumber 14 files', s: 'in_progress', sec: 72 },
    { t: 'Export: PDF', s: 'pending', sec: -1 },
  ])
  expect(g.map(x => [x.name, x.done, x.total, x.state, x.sec])).toEqual([
    ['Survey', 2, 2, 'done', 460],
    ['Renumber', 1, 2, 'current', 264],
    ['Export', 0, 1, 'todo', 0],
  ])
  expect(g[1]?.steps.map(x => x.t)).toEqual(['Set prefix', 'Renumber 14 files'])
  expect(stagesOf([{ t: 'a', s: 'pending', sec: -1 }, { t: 'b', s: 'pending', sec: -1 }]).length).toBe(1)
  // 太长的“前缀”不算阶段
  expect(splitStage('This is a long sentence that happens to have: a colon')).toBe(null)
})

test('耗时和模型名格式', async () => {
  expect([dur(34), dur(264), dur(3720)]).toEqual(['34s', '4m 24s', '1h 02m'])
  expect([clock(724), clock(3724)]).toEqual(['12:04', '1:02:04'])
  expect(modelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  expect(modelName('claude-fable-5-1')).toBe('fable 5.1')
  expect(modelName('claude-opus-5-5')).toBe('opus 5.5')
})

const row = (id: string, title: string, status: 'input' | 'running' | 'done', cacheAgeSec: number, extra = {}) => ({
  id, title, link: 'claude://claude.ai/epitaxy/local_0000', project: 'x', status, ageSec: 10, cacheAgeSec, done: 0, total: 0, current: '',
  input: 50000, cacheWrite: 20000, cacheRead: 0, output: 5000, subagents: 0, subActive: 0, ...extra,
})

test('隐藏：之后没有新请求就一直隐藏；又有请求或又在跑就回来', async () => {
  const at = 1_000_000_000
  const s = row('c', 'x', 'done', 100)
  const hiddenAt = at - 100_000
  expect(isHidden({ nextSteps: true, hidden: { c: hiddenAt } }, at, s)).toBe(true)
  expect(isHidden({ nextSteps: true, hidden: { c: hiddenAt } }, at + 600_000, { ...s, cacheAgeSec: 30 })).toBe(false)
  expect(isHidden({ nextSteps: true, hidden: { c: hiddenAt } }, at, { ...s, status: 'running' })).toBe(false)
  expect(isHidden({ nextSteps: true }, at, s)).toBe(false)
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

test('任务板：本会话有 Current 标记，展开明细，隐藏已完成会话', async ($, on) => {
  const at = Date.now()
  const board = {
    at, tick: 1, prefs: { nextSteps: false, hidden: { e: at - 600_000 } }, prefsPath: 'C:/x/prefs.json',
    usage: { at: at - 5000, limits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(at + 7_980_000).toISOString() }] },
    sessions: [
      row('a', '整理发布说明', 'running', 5, {
        done: 1, total: 3, planSec: 724, turnSec: 900, subActive: 2, model: 'claude-opus-5-5', effort: 'high',
        steps: [
          { t: 'Survey: Read notes', s: 'completed', sec: 130 },
          { t: 'Renumber: Renumber 14 files', s: 'in_progress', sec: 72 },
          { t: 'Export: PDF', s: 'pending', sec: -1 },
        ],
        subs: [
          { name: 'Explore', desc: 'old notes', model: 'claude-haiku-4-5-20251001', tool: 'Grep', sec: 34, active: true, calls: 7, step: 1 },
          { name: 'general-purpose', desc: 'schedule', model: 'claude-sonnet-5-5', effort: 'medium', tool: 'Bash', sec: 65, active: true, calls: 1 },
          { name: 'Explore', desc: 'skill notes', model: 'claude-haiku-4-5-20251001', tool: '', sec: 18, active: false, calls: 3 },
          { name: 'Explore', desc: 'old 1', model: 'claude-haiku-4-5-20251001', tool: '', sec: 9, active: false, calls: 2 },
          { name: 'Explore', desc: 'old 2', model: 'claude-haiku-4-5-20251001', tool: '', sec: 5, active: false, calls: 1 },
        ],
      }),
      row('b', '拆分明细表到各地块', 'running', 5, { turnSec: 200 }),
      row('q', '等我授权的会话', 'input', 5, { done: 2, total: 5 }),
      row('c', '最后一轮 review 台去向', 'done', 1320),
      row('e', '已隐藏的会话', 'done', 600),
    ],
  }
  on('ui.render', async ($$, e) => {
    const { Box } = $$.ui.resolve(e)
    return <Box />
  })
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'b', version: 1 } }
    return next(e)
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('fs.read', async () => ({ value: '{"nextSteps":false}' }))
  const writes: string[] = []
  on('fs.write', async (_$, e) => {
    writes.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })

  const ui = await $.ui.mount({ plugin: 'task-board', surface: 'desktop', ...BAND })
  // 本会话（b）有 Current 标签，别的没有
  expect(await ui.find({ type: 'Text', text: /^ Current $/ })).toBeDefined()
  // 已隐藏的 e 不在任务板上，Details 旁边显示数量
  expect(await ui.find({ key: 'row-e' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Details · 1 hidden/ })).toBeDefined()
  // Running 行显示总耗时
  expect(await ui.find({ type: 'Text', text: /⏱ 12:04/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^33%$/ })).toBeDefined()
  // Running 标题行右侧：账号 5 小时额度的圆环
  expect(await ui.find({ key: 'usage-ring' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^24%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /resets in 2h 13m/ })).toBeDefined()
  // 在等我决定：有清单也显示 needs input（不是百分比）
  expect(await ui.find({ type: 'Text', text: /^needs input$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^40%$/ })).toBeUndefined()

  // 展开 a 的明细：阶段、当前步骤耗时、子代理行
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
  await ui.pointer({ type: 'up', x: 1, y: 1, button: 'left', in: 'x-a' })
  expect(await ui.find({ key: 'detail' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /running 1m 12s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/3 steps · 33%/ })).toBeDefined()
  // 阶段条：名字后面跟状态；步骤表：每步一行，耗时单独一列
  expect(await ui.find({ type: 'Text', text: /^ 0% · 1m 12s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ ✓ 2m 10s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Read notes$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^2m 10s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /haiku 4\.5 · Grep · old notes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ 18s/ })).toBeDefined()
  // 推理强度、工具调用次数、画不下的汇总成一行
  expect(await ui.find({ type: 'Text', text: /sonnet 5\.5 · medium · Bash · schedule/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^7 calls$/ })).toBeDefined()
  // 第一个子代理挂在派它的那一步（Renumber 14 files）下面；其余不属于任何一步，列在 Main 行下面，最多 3 行
  expect(await ui.find({ type: 'Text', text: /^\+1 more agent · 1 done$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /old 2/ })).toBeUndefined()
  // Main 行：主会话的模型、推理强度、这一轮的子代理数
  expect(await ui.find({ type: 'Text', text: /^opus 5\.5 · high · 5 subagents this turn · 2 running$/ })).toBeDefined()
  // 卡片上也看得到这个会话正在用子代理
  expect(await ui.find({ type: 'Text', text: /^ · 2 agents$/ })).toBeDefined()
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-collapse' })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()

  // 没用子代理的会话：明说 no subagents this turn，而不是什么都不画
  await ui.pointer({ type: 'up', x: 1, y: 1, button: 'left', in: 'x-b' })
  expect(await ui.find({ type: 'Text', text: /no subagents this turn$/ })).toBeDefined()
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-collapse' })

  // 隐藏 c：写开关文件的 hidden，保留原来的 nextSteps
  await ui.pointer({ type: 'up', x: 1, y: 1, button: 'left', in: 'h-c' })
  expect(writes.length).toBe(1)
  expect(writes[0]).toMatch(/"nextSteps": false/)
  expect(writes[0]).toMatch(/"c": \d+/)
  await ui.unmount()
})

test('Details 窗：三行布局，Current / Hidden 标签，点 Unhide 写回开关文件', async ($, on) => {
  const at = Date.now()
  const board = {
    at, tick: 1, prefs: { nextSteps: false, hidden: { e: at - 600_000 } }, prefsPath: 'C:/x/prefs.json',
    sessions: [row('b', '本会话', 'running', 5), row('e', '已隐藏的会话', 'done', 600)],
  }
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'b', version: 1 } }
    return next(e)
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('fs.read', async () => ({ value: '{"nextSteps":false,"hidden":{"e":1}}' }))
  const writes: string[] = []
  on('fs.write', async (_$, e) => {
    writes.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  const ui = await $.ui.mount({
    plugin: 'task-board', surface: 'desktop', component: 'Pane', requestId: 'task-board',
    props: { title: 'Sessions', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /^Current$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Hidden$/ })).toBeDefined()
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-unhide-e' })
  expect(writes.length).toBe(1)
  expect(writes[0]).not.toMatch(/"e":/)
  await ui.unmount()
})

test('进度线不做动画：阶段条按完成比例，百分比和时间跟着清单', async () => {
  const s = row('a', 'x', 'running', 5, { done: 1, total: 3, planSec: 100, turnSec: 400 })
  expect(elapsed(s)).toBe(100)
  expect(elapsed({ ...s, done: 3 })).toBe(400)
  expect(percent(1, 3)).toBe('33%')
  expect(segSvg('current', 1, 3)).toMatch(/width="33.33%"/)
  expect(segSvg('current', 1, 3)).not.toMatch(/animate/)
  expect(segSvg('done', 2, 2)).toMatch(/width="100%" height="4" rx="2" fill="#34a853"/)
})

test('用量圆环：取新的读数，过了重置时间按 0% 算，颜色随用量变', async () => {
  const now = 1_000_000_000_000
  const old = { at: now - 60_000, limits: [{ kind: 'five_hour', percentUsed: 10 }] }
  const neu = { at: now - 1_000, limits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(now + 2_700_000).toISOString() }] }
  expect(freshest(old, neu)).toBe(neu)
  expect(freshest({ at: now, limits: [] }, old)).toBe(old)
  expect(limitNow(neu, 'five_hour', now)).toEqual({ pct: 40, left: 2700 })
  expect(limitNow(neu, 'five_hour', now + 3_000_000)).toEqual({ pct: 0, left: -1 })
  expect(limitNow(neu, 'seven_day', now)).toBe(null)
  expect([resetIn(2700), resetIn(7980), resetIn(20)]).toEqual(['45 min', '2h 13m', '1 min'])
  expect(ringSvg(40)).toMatch(/stroke="#b9b6ad"/)
  expect(ringSvg(85)).toMatch(/stroke="#d97757"/)
  expect(ringSvg(97)).toMatch(/stroke="#e5484d"/)
  expect(ringSvg(0)).not.toMatch(/stroke-dasharray/)
})

test('needs input 标记：弹授权框时写本会话的标记文件，答完清空', async ($, on) => {
  const board = { at: Date.now(), tick: 1, sessions: [], inputDir: 'C:/x/in' }
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'b', version: 1 } }
    return next(e)
  })
  const writes: { path: string; text: string }[] = []
  on('fs.write', async (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('clock.now', async () => ({ value: 1_791_000_000_000 }))
  on('classic.PermissionRequest', async () => ({}))
  on('classic.ElicitationResult', async () => ({}))
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(writes.length).toBe(1)
  expect(writes[0]?.path.replace(/\\/g, '/')).toBe('C:/x/in/b')
  expect(writes[0]?.text).toBe('1791000000000')
  await $.classic.ElicitationResult({ mcp_server_name: 'x', action: 'accept' })
  expect(writes.length).toBe(2)
  expect(writes[1]?.text).toBe('')
  // 没挂着标记时不再写
  await $.classic.ElicitationResult({ mcp_server_name: 'x', action: 'accept' })
  expect(writes.length).toBe(2)
})

test('步骤表：每个阶段只在第一行写名字；太长时先折做完的阶段，再折没开始的，当前阶段始终展开', async () => {
  const st = (stage: string, n: number, s: string) =>
    Array.from({ length: n }, (_, i) => ({ t: `${stage}: step ${i + 1}`, s, sec: s === 'pending' ? -1 : 10 }))
  const short = stagesOf([...st('Survey', 2, 'completed'), ...st('Build', 1, 'in_progress'), ...st('Deploy', 1, 'pending')])
  expect(stepLines(short).map(l => [l.stage.name, l.first, l.step?.t ?? '(folded)'])).toEqual([
    ['Survey', true, 'step 1'],
    ['Survey', false, 'step 2'],
    ['Build', true, 'step 1'],
    ['Deploy', true, 'step 1'],
  ])
  // 3 + 3 + 3 + 3 = 12 行 > 8：Survey（做完）折成一行 → 10 行，还多 → Check / Ship（没开始）也折
  const long = stagesOf([...st('Survey', 3, 'completed'), ...st('Build', 3, 'in_progress'), ...st('Check', 3, 'pending'), ...st('Ship', 3, 'pending')])
  expect(stepLines(long).map(l => (l.step ? `${l.stage.name}/${l.step.t}` : `${l.stage.name}/folded`))).toEqual([
    'Survey/folded',
    'Build/step 1',
    'Build/step 2',
    'Build/step 3',
    'Check/folded',
    'Ship/folded',
  ])
  // 只折做完的就够了：没开始的保持展开
  const mid = stagesOf([...st('Survey', 4, 'completed'), ...st('Build', 2, 'in_progress'), ...st('Check', 3, 'pending')])
  expect(stepLines(mid).filter(l => !l.step).map(l => l.stage.name)).toEqual(['Survey'])
})

test('子代理按派它的那一步分组；Main 行写出主会话的模型，没有子代理也明说', async () => {
  const sub = (name: string, step?: number, active = false) => ({ name, desc: '', model: 'claude-haiku-4-5-20251001', tool: '', sec: 5, active, step })
  const { byStep, loose } = subsByStep([sub('a', 0), sub('b', 2, true), sub('c'), sub('d', -1), sub('e', 9), sub('f', 2)], 3)
  expect([...byStep.entries()].map(([k, v]) => [k, v.map(x => x.name)])).toEqual([[0, ['a']], [2, ['b', 'f']]])
  expect(loose.map(x => x.name)).toEqual(['c', 'd', 'e'])
  expect(mainLine('claude-fable-5-1', 'high', [])).toBe('fable 5.1 · high · no subagents this turn')
  expect(mainLine('claude-opus-5-5', null, [sub('a', 0, true), sub('b')])).toBe('opus 5.5 · 2 subagents this turn · 1 running')
  expect(mainLine(null, null, [sub('a')])).toBe('1 subagent this turn')
  // 分阶段后每步还记得自己在原列表里的序号
  expect(stagesOf([{ t: 'A: x', s: 'completed', sec: 1 }, { t: 'B: y', s: 'pending', sec: -1 }]).map(g => g.steps.map(x => x.i))).toEqual([[0], [1]])
})

test('手机：窄屏单栏，按钮代替点击层；展开明细、收起、隐藏、开关都能点', async ($, on) => {
  const at = Date.now()
  const board = {
    at, tick: 1, prefs: { nextSteps: false, hidden: { e: at - 600_000 } }, prefsPath: 'C:/x/prefs.json',
    usage: { at: at - 5000, limits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(at + 7_980_000).toISOString() }] },
    sessions: [
      row('a', 'Refactor auth module', 'running', 5, {
        done: 1, total: 3, planSec: 724, turnSec: 900, subActive: 1, model: 'claude-opus-5-5', effort: 'high',
        steps: [
          { t: 'Survey: Read notes', s: 'completed', sec: 130 },
          { t: 'Renumber: Renumber 14 files', s: 'in_progress', sec: 72 },
          { t: 'Export: PDF', s: 'pending', sec: -1 },
        ],
        subs: [{ name: 'Explore', desc: 'old notes', model: 'claude-haiku-4-5-20251001', tool: 'Grep', sec: 34, active: true, calls: 7, step: 1 }],
      }),
      row('b', '本会话', 'running', 5, { turnSec: 200 }),
      row('q', '等我授权的会话', 'input', 5, { done: 2, total: 5 }),
      row('c', '做完的会话', 'done', 1320),
      row('e', '已隐藏的会话', 'done', 600),
    ],
  }
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'b', version: 1 } }
    return next(e)
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('fs.read', async () => ({ value: '{"nextSteps":false}' }))
  const writes: string[] = []
  on('fs.write', async (_$, e) => {
    writes.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })

  const ui = await $.ui.mount({ plugin: 'task-board', surface: 'mobile', ...BAND, props: { ...BAND.props, bodyColumns: 44 } })
  // 手机默认收起：只有一行摘要（在等我的排最前）和用量，没有卡片
  expect(await ui.find({ key: 'm-folded' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^● 1 needs input$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  ● 2 running$/ })).toBeDefined()
  expect(await ui.find({ key: 'm-usage' })).toBeDefined()
  expect(await ui.find({ key: 'm-row-a' })).toBeUndefined()
  // 点右端的按钮展开
  await ui.press({ key: 'm-fold' })
  expect(await ui.find({ key: 'm-folded' })).toBeUndefined()
  // 画的是手机布局（不是引擎的后备）：卡片、用量圆环、Current、needs input
  expect(await ui.find({ key: 'm-row-a' })).toBeDefined()
  expect(await ui.find({ key: 'm-usage' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ Current $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^needs input$/ })).toBeDefined()
  expect(await ui.find({ key: 'm-row-e' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ · ⏱ 12:04 · 1 agent · / })).toBeDefined()

  // 展开明细：阶段名单独一行，步骤、子代理、Main 行
  await ui.press({ key: 'm-x-a' })
  expect(await ui.find({ key: 'm-detail' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Renumber$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Renumber 14 files$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^running 1m 12s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /haiku 4\.5 · Grep · old notes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ · opus 5\.5 · high · 1 subagent this turn · 1 running$/ })).toBeDefined()
  await ui.press({ key: 'm-collapse' })
  expect(await ui.find({ key: 'm-detail' })).toBeUndefined()

  // 隐藏做完的会话、拨开关：都写回开关文件
  await ui.press({ key: 'm-h-c' })
  expect(writes.length).toBe(1)
  expect(writes[0]).toMatch(/"c": \d+/)
  await ui.press({ key: 'm-next' })
  expect(writes.length).toBe(2)
  expect(writes[1]).toMatch(/"nextSteps": true/)
  // 右下角的按钮再收起
  await ui.press({ key: 'm-fold' })
  expect(await ui.find({ key: 'm-folded' })).toBeDefined()
  expect(await ui.find({ key: 'm-row-a' })).toBeUndefined()
  await ui.unmount()
})

test('桌面：默认展开，最右下角的小箭头收起成一行，再点箭头展开', async ($, on) => {
  const at = Date.now()
  const board = {
    at, tick: 1, prefs: { nextSteps: false }, prefsPath: 'C:/x/prefs.json',
    sessions: [row('a', '在跑的会话', 'running', 5), row('q', '等我授权的会话', 'input', 5), row('c', '做完的会话', 'done', 600)],
  }
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'a', version: 1 } }
    return next(e)
  })
  on('ui.log', async () => ({ value: undefined }))
  const ui = await $.ui.mount({ plugin: 'task-board', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'row-a' })).toBeDefined()
  // 箭头是没有文字的小图标
  expect(await ui.find({ key: 'fold-btn' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Collapse|Show board/ })).toBeUndefined()
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-fold' })
  expect(await ui.find({ key: 'row-a' })).toBeUndefined()
  expect(await ui.find({ key: 'folded' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^   ● 1 needs input$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^   ● 1 done$/ })).toBeDefined()
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-fold' })
  expect(await ui.find({ key: 'row-a' })).toBeDefined()
  await ui.unmount()
})

test('桌面：下一步建议出来时，收起箭头挂在建议标题行最右边，不另占一行', async ($, on) => {
  const at = Date.now()
  const board = { at, tick: 1, prefs: { nextSteps: true }, prefsPath: 'C:/x/prefs.json', sessions: [row('a', '在跑的会话', 'running', 5)] }
  let next: { kind: string } = { kind: 'hidden' }
  on('state.get', async (_$, e, n) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'a', version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'next') return { value: { value: next, version: 1 } }
    return n(e)
  })
  on('ui.log', async () => ({ value: undefined }))
  for (const view of [
    { kind: 'offer', items: [{ label: '核对', prompt: '核对一下' }], billed: 100, cacheRead: 0 },
    { kind: 'loading', turnId: 't1' },
  ]) {
    next = view
    const ui = await $.ui.mount({ plugin: 'task-board', surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: next.kind === 'offer' ? /Suggest next step ·/ : /thinking/ })).toBeDefined()
    expect(await ui.find({ key: 'fold-btn' })).toBeDefined()
    await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-fold' })
    expect(await ui.find({ key: 'folded' })).toBeDefined()
    await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'hit-fold' })
    await ui.unmount()
  }
})

test('手机：Details 窗也能画（没有 Client，用普通按钮）', async ($, on) => {
  const at = Date.now()
  const board = { at, tick: 1, prefs: { nextSteps: false }, prefsPath: 'C:/x/prefs.json', sessions: [row('b', '本会话', 'running', 5), row('c', '做完的会话', 'done', 600)] }
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'b', version: 1 } }
    return next(e)
  })
  const ui = await $.ui.mount({
    plugin: 'task-board', surface: 'mobile', component: 'Pane', requestId: 'task-board',
    props: { title: 'Sessions', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /本会话/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /做完的会话/ })).toBeDefined()
  await ui.unmount()
})

test('共用快照：所有“过了多少秒”往后推到现在，太旧的、坏的不用', async () => {
  const at = 1_791_000_000_000
  const snap = {
    at,
    prefsPath: 'C:/p.json',
    sessions: [
      row('a', '在跑', 'running', 30, {
        total: 3, done: 1, planSec: 100, turnSec: 50,
        steps: [{ t: 'x', s: 'completed', sec: 20 }, { t: 'y', s: 'in_progress', sec: 40 }, { t: 'z', s: 'pending', sec: -1 }],
        subs: [{ name: 'Explore', desc: '', model: '', tool: 'Read', sec: 12, active: true }, { name: 'Plan', desc: '', model: '', tool: '', sec: 9, active: false }],
      }),
      row('b', '做完了', 'done', -1, { total: 2, done: 2, planSec: 70, turnSec: -1 }),
    ],
  }
  const got = rebaseScan(snap, at + 8_400, 600)
  expect(got?.at).toBe(at + 8_000)
  expect(got?.prefsPath).toBe('C:/p.json')
  const [a, b] = got?.sessions ?? []
  expect([a?.ageSec, a?.cacheAgeSec, a?.turnSec, a?.planSec]).toEqual([18, 38, 58, 108])
  expect(a?.steps?.map(x => x.sec)).toEqual([20, 48, -1])
  expect(a?.subs?.map(x => x.sec)).toEqual([20, 9])
  // 没请求过的缓存、不知道的这一轮、做完的清单都不动
  expect([b?.ageSec, b?.cacheAgeSec, b?.turnSec, b?.planSec]).toEqual([18, -1, -1, 70])
  // 隐藏判断用的“最后一次请求”时间不随平移改变
  expect((got?.at ?? 0) - (a?.cacheAgeSec ?? 0) * 1000).toBe(at - 30_000)
  expect(rebaseScan(snap, at + 601_000, 600)).toBe(null)
  expect(rebaseScan({ at: 0, sessions: [] }, at, 600)).toBe(null)
  expect(rebaseScan(null, at, 600)).toBe(null)
  expect(rebaseScan({ at, sessions: 'x' }, at, 600)).toBe(null)
})

test('新会话：一启动就用共用快照填上任务板，不等扫描进程', async ($, on) => {
  const at = 1_791_000_000_000
  const reads: string[] = []
  mock.env(on, { USERPROFILE: 'C:\\Users\\u' })
  on('fs.read', async (_$, e) => {
    reads.push(e.path)
    return { value: JSON.stringify({ at, sessions: [row('a', '别的会话', 'done', 30)], prefsPath: 'C:/p.json' }) }
  })
  const clock = mock.clock(on, { now: at + 5_000 })
  on('session.surfaces', async () => ({ value: [] }))
  on('session.id', async () => ({ value: 'me' }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  const boards: { at: number; sessions: { title: string; cacheAgeSec: number }[] }[] = []
  on('state.set', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') boards.push(e.value as (typeof boards)[number])
    return next(e)
  })
  await $.session.start({ cwd: 'C:\\w', surface: null, isInteractive: false })
  // 读快照是放到后台做的（不拖住会话启动），等它落地
  await clock.settle()
  expect(reads.map(p => p.replace(/\\/g, '/'))).toContain('C:/Users/u/.claude/task-board-snapshot.json')
  const b = boards.at(-1)
  expect(b?.at).toBe(at + 5_000)
  expect(b?.sessions.map(s => [s.title, s.cacheAgeSec])).toEqual([['别的会话', 35]])
})

test('收起箭头：灰色细线、不填底色；展开时向下、收起时向上', async () => {
  expect(foldSvg(false)).toMatch(/M7.5 9.25 11 12.75/)
  expect(foldSvg(true)).toMatch(/M7.5 12.75 11 9.25/)
  expect(foldSvg(false)).not.toMatch(/<rect/)
  expect(foldSvg(true)).toMatch(/fill="none" stroke="#8a877f"/)
})

test('跨设备：别的电脑的快照并入会话，秒数按本机时间推后；离线的设备、没名字的跳过；同一会话取最新的一份', async () => {
  const at = 1_791_000_000_000
  const got = {
    at, device: 'WinPC', os: 'win', sessions: [row('a', '本机', 'running', 5), row('dup', '本机也有', 'done', 50)],
    remote: [
      { at: at - 8_000, device: 'MacBook', os: 'mac', sessions: [row('m1', 'Mac 上的', 'running', 30, { turnSec: 100 }), row('dup', '远端同 id', 'done', 1)] },
      { at: at - 700_000, device: 'Old', os: 'mac', sessions: [row('o1', '离线的', 'running', 1)] },
      // 同步盘的冲突副本：同一台电脑两份快照，同一会话取 at 新的那份
      { at: at - 20_000, device: 'MacBook', os: 'mac', sessions: [row('m2', '旧副本', 'done', 1)] },
      { at: at - 3_000, device: 'MacBook', os: 'mac', sessions: [row('m2', '新副本', 'done', 1)] },
      { at, sessions: [row('x', '没名字', 'done', 1)] },
    ],
  }
  const s = mergeRemote(got, 600)
  expect(s.map(x => [x.id, x.title, x.device ?? '-', x.os ?? '-'])).toEqual([
    ['a', '本机', '-', '-'],
    ['dup', '本机也有', '-', '-'],
    ['m1', 'Mac 上的', 'MacBook', 'mac'],
    ['m2', '新副本', 'MacBook', 'mac'],
  ])
  const m1 = s.find(x => x.id === 'm1')
  expect([m1?.ageSec, m1?.cacheAgeSec, m1?.turnSec]).toEqual([18, 38, 108])
  expect(mergeRemote({ at, sessions: [row('a', '本机', 'running', 5)] }, 600).map(x => x.id)).toEqual(['a'])
})

test('桌面：别的电脑的会话带灰色标签（那台电脑的名字）、不可点跳转；本机的照旧可点', async ($, on) => {
  const at = Date.now()
  const board = {
    at, tick: 1, prefs: { nextSteps: false }, prefsPath: 'C:/x/prefs.json',
    sessions: [row('b', '本会话', 'running', 5), row('c', '本机别的会话', 'done', 600), row('m', 'Mac 上的会话', 'running', 5, { device: 'MacBook', os: 'mac' })],
  }
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'b', version: 1 } }
    return next(e)
  })
  on('ui.log', async () => ({ value: undefined }))
  const ui = await $.ui.mount({ plugin: 'task-board', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'row-m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ MacBook $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ Mac $/ })).toBeUndefined()
  // 远端卡没有跳转点击层；本机别的会话有
  expect(await ui.find({ key: 'go-m' })).toBeUndefined()
  expect(await ui.find({ key: 'go2-m' })).toBeUndefined()
  expect(await ui.find({ key: 'go-c' })).toBeDefined()
  // 远端卡的明细照样能展开，标题行也带标签
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'x-m' })
  expect(await ui.find({ key: 'detail' })).toBeDefined()
  expect(await ui.find({ key: 'tag-detail' })).toBeDefined()
  await ui.unmount()
})

test('Details 窗：别的电脑的会话有那台电脑的标签，没有跳转点击层', async ($, on) => {
  const at = Date.now()
  const board = {
    at, tick: 1, prefs: { nextSteps: false }, prefsPath: 'C:/x/prefs.json',
    sessions: [row('b', '本会话', 'running', 5), row('m', 'Win 上的会话', 'done', 30, { device: 'WinPC', os: 'win' })],
  }
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: board, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'me') return { value: { value: 'b', version: 1 } }
    return next(e)
  })
  on('ui.log', async () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'task-board', surface: 'desktop', component: 'Pane', requestId: 'task-board',
    props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /^WinPC$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Win$/ })).toBeUndefined()
  expect(await ui.find({ key: 'pane-go-m' })).toBeUndefined()
  expect(await ui.find({ key: 'pane-go2-m' })).toBeUndefined()
  await ui.unmount()
})
