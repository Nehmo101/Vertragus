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
import type { Edge, Node } from '@xyflow/react'
import type { OrcaTask } from '@shared/orchestrator'

export const ORCHESTRATOR_NODE_ID = 'orchestrator'

export const TASK_NODE_WIDTH = 260
export const TASK_NODE_HEIGHT = 118
export const ORCH_NODE_WIDTH = 236
export const ORCH_NODE_HEIGHT = 108

export interface CanvasOrchestratorInfo {
  /** Pane id of the orchestrator agent (used for double-click focus). */
  agentId?: string
  name: string
  model?: string
  goalTitle?: string
  goalActive: boolean
  taskCount: number
  [key: string]: unknown
}

export interface TaskNodeData {
  task: OrcaTask
  [key: string]: unknown
}

export type TaskCanvasNode = Node<TaskNodeData, 'task'>
export type OrchestratorCanvasNode = Node<CanvasOrchestratorInfo, 'orchestrator'>
export type CanvasNode = TaskCanvasNode | OrchestratorCanvasNode

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
        className: running ? 'canvas-edge-hard running' : 'canvas-edge-hard'
      })
    }
    for (const dep of (task.advisoryDependsOn ?? []).filter((d) => known.has(d))) {
      edges.push({
        id: `adv-${dep}-${task.id}`,
        source: dep,
        target: task.id,
        className: 'canvas-edge-advisory'
      })
    }
    if (hasOrchestrator && hardDeps.length === 0) {
      edges.push({
        id: `root-${task.id}`,
        source: ORCHESTRATOR_NODE_ID,
        target: task.id,
        animated: running,
        className: running ? 'canvas-edge-root running' : 'canvas-edge-root'
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

/** Build the full canvas graph; `positions` wins over the dagre auto-layout. */
export function buildCanvasGraph(
  tasks: readonly OrcaTask[],
  orchestrator: CanvasOrchestratorInfo | null,
  positions: NodePositions = {}
): CanvasGraph {
  const edges = taskEdges(tasks, orchestrator !== null)

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

  const layout = autoLayout(bare, edges, positions)
  const nodes = bare.map((node) => ({
    ...node,
    position: layout.get(node.id) ?? node.position
  })) as CanvasNode[]

  return { nodes, edges }
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
