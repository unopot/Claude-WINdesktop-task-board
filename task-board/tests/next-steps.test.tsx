import { expect, test } from 'claude-code/testing'

import { parseSuggestions } from '../hooks/next-steps'

const REPLY =
  '[{"label":"整理发布说明","prompt":"整理 v2.4 的发布说明"},' +
  '{"label":"收尾","prompt":"/task-closeout-vault"},' +
  '{"label":"假命令","prompt":"/no-such-skill 做点什么"}]'

test('建议解析：去掉本会话没有的斜杠命令，最多三条', async () => {
  const items = parseSuggestions(`好的：\n${REPLY}`, new Set(['task-closeout-vault']))
  expect(items.map(x => x.label)).toEqual(['整理发布说明', '收尾'])
  expect(parseSuggestions('没有 JSON', null)).toEqual([])
})

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

test('回答结束后 fork 出建议，点一下填进输入框', async ($, on) => {
  let forks = 0
  const filled: string[] = []
  on('ui.render', async ($$, e) => {
    const { Box } = $$.ui.resolve(e)
    return <Box />
  })
  on('turn.complete', async () => ({ text: '' }))
  on('model.fork', async () => {
    forks++
    return { value: {
      isAnswered: true,
      text: REPLY,
      usage: { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 226000, output_tokens: 120 } },
    }
  })
  on('command.list', async () => ({ value: [] }))
  on('ui.log', async () => ({ value: undefined }))
  let suggested = 0
  on('prompt.suggest', async () => {
    suggested++
    return { isShown: true }
  })
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'task-board', surface, ...BAND })
    await $.turn.complete({ reason: 'answer', answer: '这一轮做完了。'.repeat(20), durationMs: 1000, isAborted: false, turnId: `t-${surface}` })
    expect(await ui.find({ key: 'next-0' })).toBeDefined()
    expect(await ui.find({ key: 'next-2' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /this suggestion 1\.0k tok · cache read 226\.0k/ })).toBeDefined()
    // 终端是按钮；桌面是点击层，按下（down）那一刻就填，不等松开
    if (surface === 'terminal') await ui.press({ key: 'next-0' })
    else await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'hit-next-0' })
    expect(filled.at(-1)).toBe('整理 v2.4 的发布说明')
    expect(await ui.find({ key: 'next-0' })).toBeUndefined()
    await ui.unmount()
  }

  // 不再往输入框里放灰色预览（失焦时它消失，输入框变矮，上面这块跟着挪，点击会落空）
  expect(suggested).toBe(0)

  // 子代理的轮次、太短的回答都不 fork
  const before = forks
  await $.turn.complete({ reason: 'answer', answer: '短', durationMs: 1, isAborted: false, turnId: 't-short' })
  await $.turn.complete({ reason: 'answer', answer: 'x'.repeat(200), durationMs: 1, isAborted: false, turnId: 't-sub', agentId: 'a1' })
  expect(forks).toBe(before)
})

const row = (id: string, title: string, status: 'running' | 'done', cacheAgeSec: number, done = 0, total = 0) => ({
  id, title, link: '', project: 'x', status, ageSec: 10, cacheAgeSec, done, total, current: '',
  input: 50000, cacheWrite: 20000, cacheRead: 0, output: 5000, subagents: 0, subActive: 0,
})

test('原生风格任务板：每个会话一行带框，开关可见，过期会话收起', async ($, on) => {
  const board = {
    at: Date.now(), tick: 1, prefs: { nextSteps: true }, prefsPath: 'C:/x/prefs.json',
    sessions: [
      row('a', '整理发布说明', 'running', 5),
      row('b', '拆分明细表到各地块', 'running', 5, 3, 5),
      row('c', '最后一轮 review 台去向', 'done', 1320),
      row('d', 'Old session', 'done', 4000),
    ],
  }
  on('ui.render', async ($$, e) => {
    const { Box } = $$.ui.resolve(e)
    return <Box />
  })
  on('state.get', async (_$, e, next) => (e.plugin === 'task-board' && e.key === 'board' ? { value: { value: board, version: 1 } } : next(e)))
  on('ui.log', async () => ({ value: undefined }))
  const writes: unknown[] = []
  on('fs.write', async (_$, e) => {
    writes.push(e)
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'task-board', surface, ...BAND })
    if (surface === 'desktop') {
      expect(await ui.find({ key: 'row-a' })).toBeDefined()
      expect(await ui.find({ key: 'row-c' })).toBeDefined()
      expect(await ui.find({ key: 'row-d' })).toBeUndefined()
      expect(await ui.find({ key: 'next-switch' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^On$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^38 min$/ })).toBeDefined()
      // 开关、行都不再是 Button（没有旧的反色高亮），点击走透明点击层
      expect(await ui.find({ type: 'Button' })).toBeUndefined()
      await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'next-toggle' })
      expect(writes.length).toBe(1)
    } else {
      expect(await ui.find({ key: 'next-toggle' })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('桌面：建议还在 thinking… 时，点击层就先挂好（看不见），建议一出现就接得住', async ($, on) => {
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'task-board' && e.key === 'next') return { value: { value: { kind: 'loading', turnId: 't1' }, version: 1 } }
    if (e.plugin === 'task-board' && e.key === 'board') return { value: { value: { at: 0, tick: 0, sessions: [], prefs: { nextSteps: true } }, version: 1 } }
    return next(e)
  })
  on('ui.render', async ($$, e) => {
    const { Box } = $$.ui.resolve(e)
    return <Box />
  })
  const ui = await $.ui.mount({ plugin: 'task-board', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /thinking/ })).toBeDefined()
  expect(await ui.find({ key: 'hit-next-0' })).toBeDefined()
  expect(await ui.find({ key: 'hit-next-2' })).toBeDefined()
  expect(await ui.find({ key: 'hit-dismiss' })).toBeDefined()
  await ui.unmount()
})
