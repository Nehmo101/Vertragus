import { describe, expect, it } from 'vitest'
import type { OrcaTask, SubagentFinding } from '@shared/orchestrator'
import {
  MAX_CANVAS_NOTES,
  NODE_INSERT_GAP,
  NOTE_NODE_HEIGHT,
  NOTE_NODE_WIDTH,
  ORCH_NODE_HEIGHT,
  ORCH_NODE_WIDTH,
  ORCHESTRATOR_NODE_ID,
  TASK_NODE_HEIGHT,
  TASK_NODE_WIDTH,
  buildCanvasGraph,
  mergeNodePositions,
  trustSignal,
  type CanvasNode,
  type CanvasOrchestratorInfo
} from './canvasGraph'
import { rectsOverlap, type CanvasRect } from './canvasSlots'

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
    expect(ORCH_NODE_WIDTH).toBeGreaterThan(350)
    const hub = graph.nodes.find((node) => node.id === ORCHESTRATOR_NODE_ID)
    expect(hub?.type === 'orchestrator' && hub.data.goalTitle).toBe('Canvas bauen')
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
        className: 'canvas-edge-hard running',
        markerEnd: expect.objectContaining({ type: 'arrowclosed' })
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

describe('trustSignal', () => {
  const completion = { commit: 'abc1234' } as unknown as OrcaTask['completion']

  it('flags errors and active blockers red', () => {
    expect(trustSignal(task({ id: 'a', status: 'error' }))).toBe('err')
    expect(
      trustSignal(
        task({
          id: 'a',
          status: 'running',
          blocker: { code: 'X', summary: 's', details: [] } as unknown as OrcaTask['blocker']
        })
      )
    ).toBe('err')
  })

  it('flags rework, failed preflight and open gate findings amber', () => {
    expect(trustSignal(task({ id: 'a', status: 'needs-work' }))).toBe('warn')
    expect(
      trustSignal(
        task({
          id: 'a',
          status: 'running',
          findings: [{ gate: 'security', code: 'S1', message: 'm' }] as OrcaTask['findings']
        })
      )
    ).toBe('warn')
  })

  it('is only green for success with a completion proof', () => {
    expect(trustSignal(task({ id: 'a', status: 'success', completion }))).toBe('ok')
    expect(trustSignal(task({ id: 'a', status: 'success' }))).toBe('warn')
  })

  it('stays idle while nothing is verifiable yet', () => {
    expect(trustSignal(task({ id: 'a', status: 'queued' }))).toBe('idle')
    expect(trustSignal(task({ id: 'a', status: 'running' }))).toBe('idle')
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

  it('moves a newly added task clear of a live-positioned existing task', () => {
    const existing = buildCanvasGraph([task({ id: 'a' })], null).nodes.map((node) => ({
      ...node,
      position: { x: 100, y: 100 }
    }))
    const added = buildCanvasGraph([task({ id: 'a' }), task({ id: 'b' })], null).nodes.map(
      (node) => (node.id === 'b' ? { ...node, position: { x: 100, y: 100 } } : node)
    )

    const merged = mergeNodePositions(existing, added)
    expect(merged.find((node) => node.id === 'a')!.position).toEqual({ x: 100, y: 100 })
    expect(merged.find((node) => node.id === 'b')!.position).toEqual({
      x: 100,
      y: 100 + TASK_NODE_HEIGHT + NODE_INSERT_GAP
    })
  })

  it('avoids existing slots even when a new task precedes them in task order', () => {
    const existing = buildCanvasGraph([task({ id: 'existing' })], null).nodes.map((node) => ({
      ...node,
      position: { x: 0, y: 0 }
    }))
    const reordered = buildCanvasGraph(
      [task({ id: 'new' }), task({ id: 'existing' })],
      null
    ).nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } }))

    const merged = mergeNodePositions(existing, reordered)
    expect(merged.find((node) => node.id === 'existing')!.position).toEqual({ x: 0, y: 0 })
    expect(merged.find((node) => node.id === 'new')!.position.y).toBe(
      TASK_NODE_HEIGHT + NODE_INSERT_GAP
    )
  })

  it('resolves several rapid insertions against earlier nodes in the same batch', () => {
    const next = buildCanvasGraph(
      [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })],
      null
    ).nodes.map((node) => ({ ...node, position: { x: -40, y: 25 } }))

    const merged = mergeNodePositions([], next)
    expect(merged.map((node) => node.position)).toEqual([
      { x: -40, y: 25 },
      { x: -40, y: 25 + TASK_NODE_HEIGHT + NODE_INSERT_GAP },
      { x: -40, y: 25 + 2 * (TASK_NODE_HEIGHT + NODE_INSERT_GAP) }
    ])
  })

  it('accounts for different slot dimensions and relocates a colliding stored position', () => {
    const note = buildCanvasGraph(
      [],
      null,
      [finding({ id: 'f1' })],
      { 'note-f1': { x: 10, y: 10 } }
    ).nodes[0]!
    const newTask = buildCanvasGraph([task({ id: 'task' })], null, [], {
      task: { x: 10 + NOTE_NODE_WIDTH - 1, y: 10 + NOTE_NODE_HEIGHT - 1 }
    }).nodes[0]!

    const merged = mergeNodePositions([note], [note, newTask])
    expect(merged[0]!.position).toEqual({ x: 10, y: 10 })
    expect(merged[1]!.position).toEqual({
      x: 10 + NOTE_NODE_WIDTH - 1,
      y: 10 + NOTE_NODE_HEIGHT + NODE_INSERT_GAP
    })
    expect(TASK_NODE_WIDTH).toBeGreaterThan(NOTE_NODE_WIDTH)
  })
})

function nodeRect(node: CanvasNode): CanvasRect {
  if (node.type === 'orchestrator') {
    return { ...node.position, width: ORCH_NODE_WIDTH, height: ORCH_NODE_HEIGHT }
  }
  if (node.type === 'note') {
    return { ...node.position, width: NOTE_NODE_WIDTH, height: NOTE_NODE_HEIGHT }
  }
  return { ...node.position, width: TASK_NODE_WIDTH, height: TASK_NODE_HEIGHT }
}

function assertNodesDoNotOverlap(nodes: readonly CanvasNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(
        rectsOverlap(nodeRect(nodes[i]!), nodeRect(nodes[j]!)),
        `overlap between ${nodes[i]!.id} and ${nodes[j]!.id}`
      ).toBe(false)
    }
  }
}

describe('buildCanvasGraph · auto-layout slots do not overlap', () => {
  it('keeps independent and dependent task cards non-overlapping', () => {
    const graph = buildCanvasGraph(
      [
        task({ id: 'a' }),
        task({ id: 'b' }),
        task({ id: 'c', dependsOn: ['a'] }),
        task({ id: 'd', dependsOn: ['a', 'b'] })
      ],
      ORCH
    )
    assertNodesDoNotOverlap(graph.nodes)
  })

  it('places sticky-note slots beneath tasks without mutual overlap', () => {
    const findings = [1, 2, 3, 4].map((n) =>
      finding({ id: `f${n}`, taskId: 't1', createdAt: n })
    )
    const graph = buildCanvasGraph([task({ id: 't1' }), task({ id: 't2' })], ORCH, findings)
    assertNodesDoNotOverlap(graph.nodes)

    const notes = graph.nodes.filter((n) => n.type === 'note')
    expect(notes).toHaveLength(4)
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i]!.position.x - notes[i - 1]!.position.x).toBe(NOTE_NODE_WIDTH + 18)
    }
  })

  it('is deterministic across repeated builds of the same graph', () => {
    const tasks = [
      task({ id: 'a' }),
      task({ id: 'b', dependsOn: ['a'] }),
      task({ id: 'c', dependsOn: ['a'] })
    ]
    const first = buildCanvasGraph(tasks, ORCH)
    const second = buildCanvasGraph(tasks, ORCH)
    expect(second.nodes.map((n) => [n.id, n.position])).toEqual(
      first.nodes.map((n) => [n.id, n.position])
    )
    assertNodesDoNotOverlap(first.nodes)
  })
})
