import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { VertragusAppApi, WorkspaceAgentSummary } from '../../../preload'
import { AgentControls } from './AgentControls'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function bridgeFixture() {
  const calls = {
    listProviders: vi.fn(async () => [{ config: { id: 'first', label: 'First' } }, { config: { id: 'second', label: 'Second' } }]),
    discoverModels: vi.fn(async () => ({ models: [] })),
    reseatAgent: vi.fn(async () => undefined), succeedOrchestrator: vi.fn(async () => undefined)
  }
  return { calls, bridge: calls as unknown as VertragusAppApi }
}
function agent(overrides = {}): WorkspaceAgentSummary {
  return { agentId: 'worker', roleId: 'worker', name: 'Worker', state: 'working', providerId: 'first', model: 'old', effort: 'high', ...overrides } as WorkspaceAgentSummary
}
async function open(bridge: VertragusAppApi, entry = agent()) {
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(AgentControls, { agent: entry, bridge, workspaceId: 'run' })) })
  await act(async () => tree.root.findByType('details').props.onToggle({ currentTarget: { open: true } }))
  return tree
}
function button(tree: ReturnType<typeof create>, label: string) {
  return tree.root.findAllByType('button').find((entry) => entry.children.includes(label))!
}

it.each(['worker', 'orchestrator'])('changes a %s seat using its correct host API and defaults after a provider change', async (roleId) => {
  const { calls, bridge } = bridgeFixture()
  const tree = await open(bridge, agent({ roleId }))
  expect(calls.discoverModels).toHaveBeenCalledWith('first')
  await act(async () => tree.root.findAllByType('select')[0].props.onChange({ target: { value: 'second' } }))
  expect(calls.discoverModels).toHaveBeenLastCalledWith('second')
  if (roleId === 'worker') act(() => tree.root.findByType('textarea').props.onChange({ target: { value: ' Continue the failing check ' } }))
  await act(async () => button(tree, 'controls.switch').props.onClick())
  if (roleId === 'orchestrator') {
    expect(calls.succeedOrchestrator).toHaveBeenCalledWith('run', { providerId: 'second' })
    expect(calls.reseatAgent).not.toHaveBeenCalled()
  } else {
    expect(calls.reseatAgent).toHaveBeenCalledWith('run', { agentId: 'worker', providerId: 'second', reason: 'user_request', note: 'Continue the failing check' })
  }
  act(() => tree.unmount())
})

it.each(['worker', 'orchestrator'])('retries a failed %s startup and presents rejected host errors', async (roleId) => {
  vi.useFakeTimers()
  const { calls, bridge } = bridgeFixture()
  calls.reseatAgent.mockRejectedValueOnce(new Error('CLI unavailable'))
  calls.succeedOrchestrator.mockRejectedValueOnce(new Error('CLI unavailable'))
  const tree = await open(bridge, agent({ roleId, state: 'stopped', lastError: 'Handshake timed out', boot: { phase: 'waiting', startedAt: Date.now() - 2000, elapsedMs: 2000, history: [{ phase: 'cli', startedAt: 1, durationMs: 100 }, { phase: 'waiting', startedAt: Date.now() - 2000 }] } }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => button(tree, 'controls.retry').props.onClick())
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('CLI unavailable')
  expect(roleId === 'worker' ? calls.reseatAgent : calls.succeedOrchestrator).toHaveBeenCalledWith(...(roleId === 'worker' ? ['run', { agentId: 'worker', reason: 'startup_retry' }] : ['run']))
  await act(async () => button(tree, 'controls.retry').props.onClick())
  expect(tree.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  act(() => tree.unmount())
})

it('keeps the form usable if model discovery fails and ignores a result after closing', async () => {
  const { calls, bridge } = bridgeFixture()
  calls.discoverModels.mockRejectedValueOnce('Discovery unavailable')
  const tree = await open(bridge, agent({ model: undefined, effort: undefined, boot: { phase: null, elapsedMs: 1250, startedAt: 1, history: [] } }))
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Discovery unavailable')
  expect(button(tree, 'controls.switch').props.disabled).toBe(false)
  await act(async () => button(tree, 'controls.switch').props.onClick())
  expect(calls.reseatAgent).toHaveBeenCalledWith('run', { agentId: 'worker', providerId: 'first', reason: 'user_request' })
  act(() => tree.root.findByType('details').props.onToggle({ currentTarget: { open: false } }))
  expect(tree.root.findAllByProps({ className: 'panel-control-form' })).toHaveLength(0)
  act(() => tree.unmount())
})
