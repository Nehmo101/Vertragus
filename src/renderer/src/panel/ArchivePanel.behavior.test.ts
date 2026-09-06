import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { VertragusAppApi } from '../../../preload'
import { ArchivePanel } from './ArchivePanel'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('./RunTimeline', () => ({ RunTimeline: ({ workspaceId }: { workspaceId: string }) => createElement('span', { 'data-timeline': workspaceId }) }))
vi.mock('./RunReviewPanel', () => ({ RunReviewPanel: ({ workspaceId }: { workspaceId: string }) => createElement('span', { 'data-review': workspaceId }) }))
afterEach(() => vi.useRealTimers())

it('refreshes open archive rows when a live run stops and unsubscribes on close', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  let push!: () => void
  const off = vi.fn()
  const listRuns = vi.fn().mockResolvedValueOnce([{ workspaceId: 'run', status: 'running' }]).mockResolvedValue([{ workspaceId: 'run', status: 'stopped', endReason: 'user_stop' }])
  const bridge = { listRuns, onWorkspaces: (fn: () => void) => { push = fn; return off } } as unknown as VertragusAppApi
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(ArchivePanel, { profileId: 'p', liveWorkspaceIds: ['run'], bridge })) })
  expect(tree.root.findByProps({ className: 'panel-archive-pill' }).children).toContain('panel.archiveRunning')
  await act(async () => {
    tree.update(createElement(ArchivePanel, { profileId: 'p', liveWorkspaceIds: [], bridge }))
    push(); await vi.advanceTimersByTimeAsync(150)
  })
  expect(tree.root.findByProps({ className: 'panel-archive-pill' }).children).toContain('panel.archiveEndedUserStop')
  expect(listRuns).toHaveBeenCalledTimes(2)
  act(() => tree.unmount())
  expect(off).toHaveBeenCalledTimes(1)
})

it('debounces full-text searches and combines status/date filters with expandable matching runs', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const rows = [
    { workspaceId: 'live', goal: 'Current work', startedAt: Date.parse('2026-09-06'), status: 'running' },
    { workspaceId: 'old', goal: 'Earlier fix', startedAt: Date.parse('2026-09-01'), status: 'stopped', durationMs: 30_000, pullRequestUrl: 'https://example.test/pr/1' },
    { workspaceId: 'unknown', status: 'stopped', skipped: 'too_large' }
  ]
  const searchRuns = vi.fn(async () => ({ searchedRuns: 3, skipped: ['unknown'], hits: [
    { workspaceId: 'live', goal: 'Current match', startedAt: rows[0].startedAt, matches: [{ seq: 2, excerpt: 'Current journal match' }], totalMatches: 1 },
    { workspaceId: 'old', workspaceName: 'Earlier match', startedAt: rows[1].startedAt, matches: [{ seq: 3, excerpt: 'Earlier journal match' }], totalMatches: 1 }
  ] }))
  const bridge = { listRuns: async () => rows, searchRuns, onWorkspaces: () => () => undefined } as unknown as VertragusAppApi
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(ArchivePanel, { bridge, profileId: 'p', liveWorkspaceIds: ['live'] })) })
  expect(tree.root.findAllByProps({ className: 'panel-archive-item' })).toHaveLength(3)
  act(() => tree.root.findByType('select').props.onChange({ target: { value: 'stopped' } }))
  expect(tree.root.findAllByProps({ className: 'panel-archive-item' })).toHaveLength(2)
  act(() => tree.root.findByType('select').props.onChange({ target: { value: 'all' } }))
  act(() => tree.root.findByProps({ type: 'date' }).props.onChange({ target: { value: '2026-09-05' } }))
  expect(tree.root.findAllByProps({ className: 'panel-archive-item' })).toHaveLength(1)
  act(() => tree.root.findByProps({ 'aria-label': 'panel.archiveSearch' }).props.onChange({ target: { value: 'fir' } }))
  act(() => tree.root.findByProps({ 'aria-label': 'panel.archiveSearch' }).props.onChange({ target: { value: 'first' } }))
  expect(searchRuns).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(searchRuns).toHaveBeenCalledOnce()
  expect(searchRuns).toHaveBeenCalledWith('p', 'first')
  expect(JSON.stringify(tree.toJSON())).toContain('Current journal match')
  expect(JSON.stringify(tree.toJSON())).not.toContain('Earlier journal match')
  act(() => tree.root.findByProps({ className: 'panel-archive-row' }).props.onClick())
  expect(tree.root.findByProps({ 'data-review': 'live' })).toBeTruthy()
  act(() => tree.root.findByProps({ className: 'panel-archive-row' }).props.onClick())
  expect(tree.root.findAllByProps({ 'data-review': 'live' })).toHaveLength(0)
  act(() => tree.root.findByProps({ 'aria-label': 'panel.archiveSearch' }).props.onChange({ target: { value: '' } }))
  act(() => tree.root.findByProps({ type: 'date' }).props.onChange({ target: { value: '' } }))
  act(() => tree.root.findAllByProps({ className: 'panel-archive-row' })[2].props.onClick())
  expect(JSON.stringify(tree.toJSON())).toContain('panel.timelineTooLarge')
  expect(tree.root.findAllByProps({ 'data-review': 'unknown' })).toHaveLength(0)
  act(() => tree.unmount())
})

it('surfaces host list and full-text errors and discards requests that finish after close', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  let settle!: (value: unknown) => void
  const listRuns = vi.fn().mockRejectedValueOnce(new Error('Unreadable archive')).mockImplementation(() => new Promise((done) => { settle = done }))
  const searchRuns = vi.fn().mockRejectedValueOnce('Search failed')
  const bridge = { listRuns, searchRuns, onWorkspaces: () => () => undefined } as unknown as VertragusAppApi
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(ArchivePanel, { bridge, profileId: 'p', liveWorkspaceIds: [] })) })
  expect(tree.root.findByProps({ className: 'panel-retro-error' }).children).toContain('Unreadable archive')
  act(() => tree.root.findByProps({ 'aria-label': 'panel.archiveSearch' }).props.onChange({ target: { value: 'needle' } }))
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(tree.root.findByProps({ className: 'panel-retro-error' }).children).toContain('Search failed')
  await act(async () => tree.update(createElement(ArchivePanel, { bridge, profileId: 'another', liveWorkspaceIds: [] })))
  act(() => tree.unmount())
  await act(async () => settle([]))
  expect(listRuns).toHaveBeenCalledTimes(2)
})
