import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'

// 标题栏计数：桌面会话启动时插件跑一次启动器（counter.ps1 start ...），设置项 menuBar 关掉时跑 stop；没有界面的会话不碰它。

async function startSession($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], surfaces: RenderSurface[]) {
  const runs: string[][] = []
  mock.env(on, { USERPROFILE: 'C:\\Users\\u' })
  const clock = mock.clock(on, { now: 1_791_000_000_000 })
  on('fs.read', async () => ({ value: '' }))
  on('fs.exists', async () => ({ value: true }))
  on('session.surfaces', async () => ({ value: surfaces }))
  on('session.id', async () => ({ value: 'me' }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', async () => ({ value: undefined }))
  // 扫描进程：立刻结束，什么都不输出
  on('process.spawn', async function* () {
    yield* []
    return { value: { code: 0, signal: null } }
  } as never)
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'started\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: 'C:\\Users\\u\\w', surface: null, isInteractive: true })
  await clock.settle()
  return runs.filter(argv => argv[5]?.endsWith('/counter.ps1'))
}

test('标题栏计数：桌面会话启动时拉起（缓存分钟数、本机标签、共享目录都传过去）', { options: { deviceName: 'Mini', cacheTtlMinutes: 5 } }, async ($, on) => {
  const runs = await startSession($, on, ['desktop'])
  expect(runs.length).toBe(1)
  const [ps, , , , file, launcher, verb, ttl, device, shared] = runs[0] ?? []
  expect([ps, file, verb, ttl, device]).toEqual(['powershell.exe', '-File', 'start', '5', 'Mini'])
  expect(launcher).toMatch(/\/counter\.ps1$/)
  expect(shared).toMatch(/task-board-shared$/)
})

test('标题栏计数：共享目录为空就不传（PowerShell 5.1 会吞掉空参数）', { options: { sharedDir: '' } }, async ($, on) => {
  const runs = await startSession($, on, ['desktop'])
  expect(runs.map(argv => argv.slice(6))).toEqual([['start', '60', 'Win']])
})

test('标题栏计数：设置项 menuBar 关掉 = 停掉在跑的', { options: { menuBar: false } }, async ($, on) => {
  const runs = await startSession($, on, ['desktop'])
  expect(runs.map(argv => argv.slice(6))).toEqual([['stop']])
})

test('标题栏计数：没有界面的会话（claude -p、定时任务）不碰它', async ($, on) => {
  const runs = await startSession($, on, [])
  expect(runs).toEqual([])
})
