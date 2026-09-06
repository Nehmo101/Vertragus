import { expect, it, vi } from 'vitest'
import { callTool, captureTools, fakeRuntime } from './testing'
import { registerSubagentTools } from './toolsSubagent'

it('does not publish or adopt an old process report whose snapshot finishes after reseat', async () => {
  const runtime = fakeRuntime()
  const started = runtime.host.beginAgent({ role: 'worker', task: 'Parser' })
  let generation = 1
  Object.assign(runtime.host, { agentGeneration: () => generation })
  const tools = captureTools((server) => registerSubagentTools(server, runtime, started.agentId))
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const inSnapshot = new Promise<void>((resolve) => { entered = resolve })
  const snapshot = runtime.host.snapshotDone.bind(runtime.host)
  vi.spyOn(runtime.host, 'snapshotDone').mockImplementation(async (...args) => {
    entered()
    await gate
    return snapshot(...args)
  })
  const result = callTool(tools, 'report_done', { summary: 'Old generation result' })
  await inSnapshot
  generation++
  release()
  expect((await result).json.error).toBe('session_replaced')
  expect(runtime.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(0)
})
