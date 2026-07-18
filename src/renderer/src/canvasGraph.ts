/**
 * Pure mapping from orchestrator tasks to the React-Flow canvas graph.
 *
 * Tasks become task nodes, the orchestrator becomes a bronze root node.
 * `dependsOn` renders as a hard edge (verdigris + animated while the
 * dependent task runs), `advisoryDependsOn` as a dashed bronze edge and
 * tasks without any resolvable hard dependency hang off the orchestrator.
 * Nodes without a stored position are laid out left-to-right with dagre.
 */
import dagre from 'dagre'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { OrcaTask, SubagentFinding } from '@shared/orchestrator'

/* Arrowhead colors are fixed midtones that read on both themes — SVG marker
   fills cannot resolve CSS custom properties. */
const ARROW_NEUTRAL = '#8a8b84'
const ARROW_VERDIGRIS = '#2f7d6d'
const ARROW_BRONZE = '#b08a3e'

function arrow(color: string): Edge['markerEnd'] {
  return { type: MarkerType.ArrowClosed, width: 15, height: 15, color }
}

export const ORCHESTRATOR_NODE_ID = 'orchestrator'

export const TASK_NODE_WIDTH = 260
export const TASK_NODE_HEIGHT = 118
export const ORCH_NODE_WIDTH = 380
export const ORCH_NODE_HEIGHT = 178
export const NOTE_NODE_WIDTH = 220
export const NOTE_NODE_HEIGHT = 122
/** The canvas shows the newest findings as sticky notes; older ones stay in the side panel. */
export const MAX_CANVAS_NOTES = 8

export interface CanvasOrchestratorInfo {
  /** Pane id of the orchestrator agent (used for double-click focus). */
  agentId?: string
  name: string
  model?: string
  goalTitle?: string
  goalActive: boolean
  taskCount: number
  activity?: string
  status?: string
  [key: string]: unknown
}

export interface TaskNodeData {
  task: OrcaTask
  [key: string]: unknown
}

export interface NoteNodeData {
  finding: SubagentFinding
  [key: string]: unknown
}

export type TaskCanvasNode = Node<TaskNodeData, 'task'>
export type OrchestratorCanvasNode = Node<CanvasOrchestratorInfo, 'orchestrator'>
export type NoteCanvasNode = Node<NoteNodeData, 'note'>
export type CanvasNode = TaskCanvasNode | OrchestratorCanvasNode | NoteCanvasNode

export type NodePosition = { x: number; y: number }
export type NodePositions = Record<string, NodePosition>

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: Edge[]
}

function taskEdges(tasks: readonly OrcaTask[], hasOrchestrator: boolean): Edge[] {
  const known = new Set(tasks.map((task) => task.id))
  const edges: Edge[] = []

  for (const task of tasks) {
    const running = task.status === 'running'
    const hardDeps = (task.dependsOn ?? []).filter((dep) => known.has(dep))
    for (const dep of hardDeps) {
      edges.push({
        id: `hard-${dep}-${task.id}`,
        source: dep,
        target: task.id,
        animated: running,
        className: running ? 'canvas-edge-hard running' : 'canvas-edge-hard',
        markerEnd: arrow(running ? ARROW_VERDIGRIS : ARROW_NEUTRAL)
      })
    }
    for (const dep of (task.advisoryDependsOn ?? []).filter((d) => known.has(d))) {
      edges.push({
        id: `adv-${dep}-${task.id}`,
        source: dep,
        target: task.id,
        className: 'canvas-edge-advisory',
        markerEnd: arrow(ARROW_BRONZE)
      })
    }
    if (hasOrchestrator && hardDeps.length === 0) {
      edges.push({
        id: `root-${task.id}`,
        source: ORCHESTRATOR_NODE_ID,
        target: task.id,
        animated: running,
        className: running ? 'canvas-edge-root running' : 'canvas-edge-root',
        markerEnd: arrow(running ? ARROW_VERDIGRIS : ARROW_BRONZE)
      })
    }
  }
  return edges
}

function autoLayout(
  nodes: readonly CanvasNode[],
  edges: readonly Edge[],
  positions: NodePositions
): Map<string, NodePosition> {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 42, ranksep: 96, marginx: 32, marginy: 32 })
  graph.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) {
    const isOrch = node.type === 'orchestrator'
    graph.setNode(node.id, {
      width: isOrch ? ORCH_NODE_WIDTH : TASK_NODE_WIDTH,
      height: isOrch ? ORCH_NODE_HEIGHT : TASK_NODE_HEIGHT
    })
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target)
  }
  dagre.layout(graph)

  const resolved = new Map<string, NodePosition>()
  for (const node of nodes) {
    const stored = positions[node.id]
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      resolved.set(node.id, { x: stored.x, y: stored.y })
      continue
    }
    const laidOut = graph.node(node.id)
    const isOrch = node.type === 'orchestrator'
    resolved.set(node.id, {
      x: laidOut.x - (isOrch ? ORCH_NODE_WIDTH : TASK_NODE_WIDTH) / 2,
      y: laidOut.y - (isOrch ? ORCH_NODE_HEIGHT : TASK_NODE_HEIGHT) / 2
    })
  }
  return resolved
}

/**
 * Build the full canvas graph; `positions` wins over the dagre auto-layout.
 * The newest findings render as sticky notes in a row beneath the graph,
 * each linked to its originating task with a faint dotted edge — this is the
 * bidirectional half of the canvas: subagents write onto the board mid-run.
 */
export function buildCanvasGraph(
  tasks: readonly OrcaTask[],
  orchestrator: CanvasOrchestratorInfo | null,
  findings: readonly SubagentFinding[] = [],
  positions: NodePositions = {}
): CanvasGraph {
  const edges = taskEdges(tasks, orchestrator !== null)
  const known = new Set(tasks.map((task) => task.id))

  const bare: CanvasNode[] = []
  if (orchestrator) {
    bare.push({
      id: ORCHESTRATOR_NODE_ID,
      type: 'orchestrator',
      position: { x: 0, y: 0 },
      data: orchestrator,
      draggable: true
    })
  }
  for (const task of tasks) {
    bare.push({
      id: task.id,
      type: 'task',
      position: { x: 0, y: 0 },
      data: { task },
      draggable: true
    })
  }

  const notes = [...findings]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_CANVAS_NOTES)
  // Note edges stay out of the dagre pass — their nodes are placed manually.
  const noteEdges: Edge[] = notes
    .filter((finding) => known.has(finding.taskId))
    .map((finding) => ({
      id: `note-${finding.taskId}-${finding.id}`,
      source: finding.taskId,
      target: `note-${finding.id}`,
      className: 'canvas-edge-note'
    }))

  const layout = autoLayout(bare, edges, positions)
  const laidOut = bare.map((node) => ({
    ...node,
    position: layout.get(node.id) ?? node.position
  })) as CanvasNode[]

  // Notes sit in a row beneath the laid-out graph unless the user moved them.
  const bottom = laidOut.reduce(
    (max, node) => Math.max(max, node.position.y + TASK_NODE_HEIGHT),
    0
  )
  const noteNodes: CanvasNode[] = notes.map((finding, index) => {
    const id = `note-${finding.id}`
    const stored = positions[id]
    return {
      id,
      type: 'note',
      position:
        stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)
          ? { x: stored.x, y: stored.y }
          : { x: 24 + index * (NOTE_NODE_WIDTH + 18), y: bottom + 56 },
      data: { finding },
      draggable: true
    }
  })

  return { nodes: [...laidOut, ...noteNodes], edges: [...edges, ...noteEdges] }
}

export type TrustSignal = 'ok' | 'warn' | 'err' | 'idle'

/**
 * Trust-Ampel for a task — the canvas answer to "why is this green?".
 * err: failed or actively blocked; warn: rework, failed preflight or open
 * gate findings; ok: verified success (terminal status AND a completion
 * proof); idle: nothing to verify yet.
 */
export function trustSignal(task: OrcaTask): TrustSignal {
  if (task.status === 'error' || task.blocker) return 'err'
  if (
    task.status === 'needs-work' ||
    (task.findings?.length ?? 0) > 0 ||
    task.preflight?.status === 'failed'
  ) {
    return 'warn'
  }
  if (task.status === 'success') return task.completion ? 'ok' : 'warn'
  return 'idle'
}

/**
 * Carry live drag positions across graph rebuilds: a node that already exists
 * keeps its current position; brand-new nodes take the freshly computed one.
 */
export function mergeNodePositions(
  previous: readonly CanvasNode[],
  next: readonly CanvasNode[]
): CanvasNode[] {
  const prevById = new Map(previous.map((node) => [node.id, node]))
  return next.map((node) => {
    const prev = prevById.get(node.id)
    return prev ? ({ ...node, position: prev.position } as CanvasNode) : node
  })
}
