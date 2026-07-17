import { describe, expect, it } from 'vitest'
import type { OrcaTask, SubagentFinding } from '@shared/orchestrator'
import {
  MAX_CANVAS_NOTES,
  ORCHESTRATOR_NODE_ID,
  buildCanvasGraph,
  mergeNodePositions,
  type CanvasOrchestratorInfo
} from './canvasGraph'

function task(overrides: Partial<OrcaTask> & { id: string }): OrcaTask {
  return {
    title: overrides.id,
    role: 'worker',
    status: 'queued',
    createdAt: 0,
    ...overrides
  }
}

const ORCH: CanvasOrchestratorInfo = {
  agentId: 'orch-1',
  name: 'Virgilio',
  goalTitle: 'Canvas bauen',
  goalActive: true,
  taskCount: 2
}

describe('buildCanvasGraph', () => {
  it('maps every task to a task node and the orchestrator to the root node', () => {
    const graph = buildCanvasGraph([task({ id: 't1' }), task({ id: 't2' })], ORCH)

    expect(graph.nodes.map((n) => `${n.type}:${n.id}`)).toEqual([
      `orchestrator:${ORCHESTRATOR_NODE_ID}`,
      'task:t1',
      'task:t2'
    ])
    const t1 = graph.nodes.find((n) => n.id === 't1')
    expect(t1?.type === 'task' && t1.data.task.id).toBe('t1')
  })

  it('renders hard dependencies as hard edges and animates them while the dependent runs', () => {
    const graph = buildCanvasGraph(
      [task({ id: 'a', status: 'success' }), task({ id: 'b', status: 'running', dependsOn: ['a'] })],
      null
    )

    expect(graph.edges).toEqual([
      expect.objectContaining({
        source: 'a',
        target: 'b',
        animated: true,
        className: 'canvas-edge-hard running'
      })
    ])
  })

  it('renders advisory dependencies as non-animated advisory edges', () => {
    const graph = buildCanvasGraph(
      [task({ id: 'a' }), task({ id: 'b', advisoryDependsOn: ['a'] })],
      null
    )

    const advisory = graph.edges.find((e) => e.id === 'adv-a-b')
    expect(advisory?.className).toBe('canvas-edge-advisory')
    expect(advisory?.animated).toBeUndefined()
  })

  it('hangs tasks without resolvable hard deps off the orchestrator', () => {
    const graph = buildCanvasGraph(
      [task({ id: 'root' }), task({ id: 'child', dependsOn: ['root'] }), task({ id: 'ghost', dependsOn: ['missing'] })],
      ORCH
    )

    const rootEdges = graph.edges.filter((e) => e.source === ORCHESTRATOR_NODE_ID)
    expect(rootEdges.map((e) => e.target).sort()).toEqual(['ghost', 'root'])
  })

  it('gives dependent nodes a larger x than their dependency (LR auto-layout)', () => {
    const graph = buildCanvasGraph(
      [task({ id: 'a' }), task({ id: 'b', dependsOn: ['a'] })],
      null
    )
    const byId = new Map(graph.nodes.map((n) => [n.id, n.position]))
    expect(byId.get('b')!.x).toBeGreaterThan(byId.get('a')!.x)
  })

  it('prefers stored positions over the auto-layout', () => {
    const graph = buildCanvasGraph([task({ id: 'a' })], null, [], { a: { x: 421, y: 77 } })
    expect(graph.nodes[0]!.position).toEqual({ x: 421, y: 77 })
  })
})

function finding(overrides: Partial<SubagentFinding> & { id: string }): SubagentFinding {
  return {
    taskId: 't1',
    kind: 'insight',
    title: overrides.id,
    detail: 'Detail',
    createdAt: 1,
    ...overrides
  }
}

describe('buildCanvasGraph · findings as sticky notes', () => {
  it('renders a finding as a note node linked to its task with a dotted edge', () => {
    const graph = buildCanvasGraph(
      [task({ id: 't1' })],
      null,
      [finding({ id: 'f1', agentName: 'Caronte' })]
    )

    const note = graph.nodes.find((n) => n.id === 'note-f1')
    expect(note?.type).toBe('note')
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 't1', target: 'note-f1', className: 'canvas-edge-note' })
    )
  })

  it('places notes beneath the graph but honours a stored note position', () => {
    const graph = buildCanvasGraph(
      [task({ id: 't1' })],
      null,
      [finding({ id: 'f1' }), finding({ id: 'f2', createdAt: 2 })],
      { 'note-f2': { x: 3, y: 4 } }
    )

    const taskNode = graph.nodes.find((n) => n.id === 't1')!
    const autoNote = graph.nodes.find((n) => n.id === 'note-f1')!
    expect(autoNote.position.y).toBeGreaterThan(taskNode.position.y)
    expect(graph.nodes.find((n) => n.id === 'note-f2')!.position).toEqual({ x: 3, y: 4 })
  })

  it('caps the board at the newest MAX_CANVAS_NOTES findings and skips unknown-task edges', () => {
    const many = Array.from({ length: MAX_CANVAS_NOTES + 3 }, (_, i) =>
      finding({ id: `f${i}`, taskId: 'missing', createdAt: i })
    )
    const graph = buildCanvasGraph([task({ id: 't1' })], null, many)

    const notes = graph.nodes.filter((n) => n.type === 'note')
    expect(notes).toHaveLength(MAX_CANVAS_NOTES)
    expect(notes.some((n) => n.id === 'f0')).toBe(false)
    expect(graph.edges.filter((e) => e.className === 'canvas-edge-note')).toHaveLength(0)
  })
})

describe('mergeNodePositions', () => {
  it('keeps the live position of already-known nodes and adopts new nodes as-is', () => {
    const first = buildCanvasGraph([task({ id: 'a' })], null).nodes
    const dragged = first.map((n) => ({ ...n, position: { x: 9, y: 9 } }))
    const rebuilt = buildCanvasGraph([task({ id: 'a' }), task({ id: 'b' })], null).nodes

    const merged = mergeNodePositions(dragged, rebuilt)
    expect(merged.find((n) => n.id === 'a')!.position).toEqual({ x: 9, y: 9 })
    expect(merged.find((n) => n.id === 'b')!.position).not.toEqual({ x: 9, y: 9 })
  })
})
