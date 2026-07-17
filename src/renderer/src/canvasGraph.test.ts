import { describe, expect, it } from 'vitest'
import type { OrcaTask } from '@shared/orchestrator'
import {
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
    const graph = buildCanvasGraph([task({ id: 'a' })], null, { a: { x: 421, y: 77 } })
    expect(graph.nodes[0]!.position).toEqual({ x: 421, y: 77 })
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
