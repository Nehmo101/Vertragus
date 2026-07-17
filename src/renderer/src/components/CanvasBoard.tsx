/**
 * The spatial workspace canvas: orchestrator + tasks as draggable nodes,
 * dependencies as edges. Hard dependencies pulse verdigris while the
 * dependent task runs, advisory dependencies render dashed bronze.
 * Node positions persist per profile + workspace session.
 */
import { useEffect, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type NodeProps,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag
} from '@xyflow/react'
import { useAppStore, workspaceAgents } from '@renderer/store/useAppStore'
import { canvasBoardKey, selectBoardPositions, useCanvasStore } from '@renderer/store/canvasStore'
import {
  buildCanvasGraph,
  mergeNodePositions,
  type CanvasNode,
  type CanvasOrchestratorInfo,
  type NoteNodeData,
  type TaskNodeData
} from '@renderer/canvasGraph'
import LoreName from '@renderer/components/LoreName'
import { summarizeUsage } from '@shared/telemetry'
import { formatTokenCount, formatUsd } from '@renderer/telemetryFormat'
import type { SubagentFindingKind, TaskStatus } from '@shared/orchestrator'

const NOTE_KIND_LABEL: Record<SubagentFindingKind, string> = {
  interface: 'Schnittstelle',
  decision: 'Entscheidung',
  blocker: 'Blocker',
  insight: 'Erkenntnis'
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'geplant',
  paused: 'pausiert',
  waiting: 'wartet',
  running: 'läuft',
  success: 'fertig',
  'needs-work': 'Nacharbeit',
  error: 'Fehler',
  stopped: 'gestoppt'
}

function statusClass(status: TaskStatus): string {
  if (status === 'running') return 'running'
  if (status === 'success') return 'success'
  if (status === 'error' || status === 'needs-work') return 'error'
  return 'idle'
}

function heartbeatText(lastHeartbeatAt: number | undefined, createdAt: number): string | null {
  const base = lastHeartbeatAt ?? createdAt
  const seconds = Math.max(0, Math.floor((Date.now() - base) / 1000))
  if (lastHeartbeatAt == null) return 'Heartbeat ausstehend'
  if (seconds < 60) return `Heartbeat vor ${seconds}s`
  return `Heartbeat vor ${Math.floor(seconds / 60)}m`
}

function TaskNode({ data }: NodeProps<Node<TaskNodeData, 'task'>>): JSX.Element {
  const { task } = data
  const usage = summarizeUsage(task.usage)
  const usageParts: string[] = []
  if (usage.tokens != null) usageParts.push(`${formatTokenCount(usage.tokens)} Tok`)
  if (usage.costUsd != null) usageParts.push(formatUsd(usage.costUsd))
  const running = task.status === 'running'

  return (
    <div className={`canvas-node canvas-node--task ${statusClass(task.status)}`}>
      <Handle type="target" position={Position.Left} className="canvas-handle" />
      <div className="canvas-node__head">
        <span className={`canvas-node__dot ${statusClass(task.status)}`} />
        <span className="canvas-node__title" title={task.title}>
          {task.title}
        </span>
        <span className="canvas-node__status">{STATUS_LABEL[task.status]}</span>
      </div>
      <div className="canvas-node__meta">
        {task.agentName ? (
          <>
            <LoreName name={task.agentName} className="canvas-node__agent" />
            {` · ${task.role}`}
          </>
        ) : (
          task.role
        )}
        {task.model ? ` · ${task.model}` : ''}
      </div>
      {running && (
        <div className="canvas-node__bar">
          <span
            className={`canvas-node__bar-fill ${task.progress == null ? 'indeterminate' : ''}`}
            style={task.progress == null ? undefined : { width: `${Math.min(100, Math.max(0, task.progress))}%` }}
          />
        </div>
      )}
      <div className="canvas-node__foot">
        {running && <span>{heartbeatText(task.lastHeartbeatAt, task.createdAt)}</span>}
        {usageParts.length > 0 && <span>{usageParts.join(' · ')}</span>}
        {!running && task.note && (
          <span className="canvas-node__note" title={task.note}>
            {task.note}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="canvas-handle" />
    </div>
  )
}

function OrchestratorNode({ data }: NodeProps<Node<CanvasOrchestratorInfo, 'orchestrator'>>): JSX.Element {
  return (
    <div className="canvas-node canvas-node--orchestrator">
      <div className="canvas-node__head">
        <span className={`canvas-node__dot orchestrator ${data.goalActive ? 'running' : ''}`} />
        <LoreName name={data.name} className="canvas-node__title" />
        <span className="canvas-node__status">Orchestrator</span>
      </div>
      <div className="canvas-node__meta">
        {data.goalActive ? `plant · ${data.taskCount} Tasks` : 'kein aktives Ziel'}
        {data.model ? ` · ${data.model}` : ''}
      </div>
      {data.goalTitle && (
        <div className="canvas-node__foot">
          <span className="canvas-node__goal" title={data.goalTitle}>
            Ziel: „{data.goalTitle}“
          </span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="canvas-handle" />
    </div>
  )
}

function NoteNode({ data }: NodeProps<Node<NoteNodeData, 'note'>>): JSX.Element {
  const { finding } = data
  return (
    <div className={`canvas-node canvas-node--note kind-${finding.kind}`}>
      <Handle type="target" position={Position.Left} className="canvas-handle" />
      <div className="canvas-node__head">
        <span className="canvas-note__kind">{NOTE_KIND_LABEL[finding.kind]}</span>
        <span className="canvas-node__title" title={finding.title}>
          {finding.title}
        </span>
      </div>
      <div className="canvas-note__detail" title={finding.detail}>
        {finding.detail}
      </div>
      {finding.agentName && (
        <div className="canvas-node__foot">
          <span>
            ✎ <LoreName name={finding.agentName} className="canvas-node__agent" />
          </span>
        </div>
      )}
    </div>
  )
}

const NODE_TYPES = { task: TaskNode, orchestrator: OrchestratorNode, note: NoteNode }

export default function CanvasBoard(): JSX.Element {
  const store = useAppStore()
  const tasks = store.orchestrator.tasks
  const goal = store.orchestrator.goal
  const boardKey = canvasBoardKey(store.activeProfileId, store.activeWorkspaceSessionId ?? undefined)
  const positions = useCanvasStore(selectBoardPositions(boardKey))
  const setPosition = useCanvasStore((state) => state.setPosition)

  const orchAgent = workspaceAgents(store).find((agent) => agent.kind === 'orchestrator')
  const orchestrator: CanvasOrchestratorInfo | null = orchAgent
    ? {
        agentId: orchAgent.id,
        name: orchAgent.name,
        model: orchAgent.model,
        goalTitle: goal?.title,
        goalActive: Boolean(goal?.active),
        taskCount: tasks.length
      }
    : null

  const findings = store.orchestrator.findings
  const graph = useMemo(
    () => buildCanvasGraph(tasks, orchestrator, findings ?? [], positions),
    // Positions are intentionally applied only on rebuilds; live drags update
    // the store on drag-stop and survive via mergeNodePositions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, findings, orchAgent?.id, orchAgent?.name, orchAgent?.model, goal?.title, goal?.active]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  useEffect(() => {
    setNodes((previous) => mergeNodePositions(previous, graph.nodes))
  }, [graph, setNodes])

  const onNodeDragStop: OnNodeDrag<CanvasNode> = (_event, node) => {
    setPosition(boardKey, node.id, { x: node.position.x, y: node.position.y })
  }

  const onNodeDoubleClick: NodeMouseHandler<CanvasNode> = (_event, node) => {
    const agentId =
      node.type === 'task'
        ? node.data.task.agentId
        : node.type === 'orchestrator'
          ? node.data.agentId
          : undefined
    if (typeof agentId === 'string' && agentId) store.setSelectedAgent(agentId)
  }

  if (tasks.length === 0 && !orchestrator) {
    return (
      <div className="canvas-empty" role="status">
        <div className="big">Canvas ist bereit</div>
        <div>Starte den Workspace oder gib dem Orchestrator ein Ziel — Tasks erscheinen hier als Knoten.</div>
      </div>
    )
  }

  return (
    <div className="vertragus-canvas" aria-label="Aufgaben-Canvas">
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        fitView
        minZoom={0.25}
        maxZoom={1.75}
        nodesConnectable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} className="canvas-bg" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" pannable zoomable className="canvas-minimap" />
      </ReactFlow>
    </div>
  )
}
