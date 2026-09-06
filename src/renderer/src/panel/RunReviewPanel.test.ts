import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { VertragusAppApi, WorkspaceAgentSummary } from '../../../preload'
import type { RunReview } from '@shared/runReview'
import type { AgentEvent } from '@shared/schema/events'
import { RunReviewPanel } from './RunReviewPanel'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('recovers the selected branch and retries failed finalization through the host', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const review: RunReview = {
    workspaceId: 'run', branches: [
      { branch: 'old-root', head: 'abc123', path: 'C:/root', root: true, dirty: false, ahead: 2 },
      { branch: 'worker-fix', head: 'def456', path: 'C:/worker', root: false, dirty: true, changedFiles: ['fix.ts'] }
    ],
    events: [], finalization: { status: 'failed', attempts: 1, updatedAt: 1, error: 'Network unavailable' }
  }
  const resumeWorkspace = vi.fn(async () => undefined)
  const retryRunFinalization = vi.fn(async () => undefined)
  const getRunReview = vi.fn(async () => review)
  const bridge = { getRunReview, resumeWorkspace, retryRunFinalization, onWorkspaces: () => () => undefined } as unknown as VertragusAppApi
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(RunReviewPanel, { bridge, profileId: 'profile', workspaceId: 'run' })) })
  act(() => tree.root.findByType('select').props.onChange({ target: { value: 'worker-fix' } }))
  const button = (label: string) => tree.root.findAllByType('button').find((entry) => entry.children.includes(label))!
  await act(async () => button('review.resume').props.onClick())
  expect(resumeWorkspace).toHaveBeenCalledWith('profile', { workspaceId: 'run', baseBranch: 'worker-fix' })
  await act(async () => button('review.retry').props.onClick())
  expect(retryRunFinalization).toHaveBeenCalledWith('profile', 'run')
  expect(getRunReview).toHaveBeenCalledTimes(2)
  act(() => tree.unmount())
})

it('shows reported snapshots separately from checkout integration and promotes only the selected stopped agent', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const events = [
    { type: 'agent_started', seq: 1, agentId: 'worker', branch: 'fix' },
    { type: 'agent_done', seq: 2, agentId: 'worker', branch: 'fix', name: 'Worker', status: 'done', summary: 'Checks passed before later edits', headSha: 'oldsha', snapshotError: 'Dirty snapshot could not be created' },
    { type: 'integrate_ok', seq: 3, branch: 'fix', target: 'checkout', headSha: 'mergesha' },
    { type: 'integrate_ok', seq: 4, branch: 'fix', target: 'orchestrator', headSha: 'rootsha' },
    { type: 'integrate_conflict', seq: 5, branch: 'fix', message: 'Conflict in changed.ts' }
  ] as unknown as AgentEvent[]
  const review = { workspaceId: 'run', branches: [{ branch: 'fix', path: 'C:/fix', root: false }], events,
    tasks: { tasks: [{ taskId: 'open', subject: 'Still review the diff', status: 'pending' }, { taskId: 'done', subject: 'Already complete', status: 'completed' }] },
    finalization: { status: 'completed', attempts: 2, updatedAt: 1, url: 'https://example.test/pr/1' }
  } as RunReview
  const getRunReview = vi.fn(async () => review)
  const promoteAgentBranch = vi.fn(async () => undefined)
  const bridge = { getRunReview, promoteAgentBranch, onWorkspaces: () => () => undefined } as unknown as VertragusAppApi
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(RunReviewPanel, { bridge, profileId: 'p', workspaceId: 'run', live: true, agents: [{ agentId: 'worker', state: 'stopped' } as WorkspaceAgentSummary] })) })
  const output = JSON.stringify(tree.toJSON())
  for (const text of ['Dirty snapshot', 'mergesha', 'rootsha', 'Conflict in', 'Still review', 'review.verificationHint']) expect(output).toContain(text)
  expect(output).not.toContain('Already complete')
  expect(tree.root.findByType('a').props.href).toBe('https://example.test/pr/1')
  expect(tree.root.findAllByType('button').some((entry) => entry.children.includes('review.resume'))).toBe(false)
  await act(async () => tree.root.findByType('button').props.onClick())
  expect(promoteAgentBranch).toHaveBeenCalledWith('run', 'worker')
  expect(getRunReview).toHaveBeenCalledTimes(2)
  act(() => tree.unmount())
})

it('retains finalization and the chosen branch after a failed retry, then tolerates an empty recovery', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const review: RunReview = { workspaceId: 'run', branches: [{ branch: 'fix', path: '/fix', root: false }], events: [], finalization: { status: 'pending', attempts: 0, updatedAt: 1 } }
  let push!: () => void
  const getRunReview = vi.fn(async () => review)
  const retryRunFinalization = vi.fn(async () => { throw new Error('Still offline') })
  const bridge = { getRunReview, retryRunFinalization, onWorkspaces: (fn: () => void) => { push = fn; return () => undefined } } as unknown as VertragusAppApi
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(RunReviewPanel, { bridge, profileId: 'p', workspaceId: 'run' })) })
  await act(async () => tree.root.findAllByType('button').find((entry) => entry.children.includes('review.retry'))!.props.onClick())
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Still offline')
  expect(tree.root.findByType('select').props.value).toBe('fix')
  getRunReview.mockResolvedValue({ workspaceId: 'run', branches: [], events: [] })
  vi.useFakeTimers()
  await act(async () => { push(); await vi.advanceTimersByTimeAsync(150) })
  expect(JSON.stringify(tree.toJSON())).toContain('review.noBranches')
  act(() => tree.unmount())
  vi.useRealTimers()
})

it('displays a failed initial host read and unsubscribes without applying a late result', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const off = vi.fn()
  const getRunReview = vi.fn(async () => { throw 'Journal unavailable' })
  const bridge = { getRunReview, onWorkspaces: () => off } as unknown as VertragusAppApi
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(RunReviewPanel, { bridge, profileId: 'p', workspaceId: 'run' })) })
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Journal unavailable')
  act(() => tree.unmount())
  expect(off).toHaveBeenCalledOnce()
})
