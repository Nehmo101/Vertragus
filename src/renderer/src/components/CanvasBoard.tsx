/**
 * The spatial workspace canvas: orchestrator + tasks as draggable nodes,
 * dependencies as edges. Hard dependencies pulse verdigris while the
 * dependent task runs, advisory dependencies render dashed bronze.
 * Node positions persist per profile + workspace session.
 */
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
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
  trustSignal,
  type CanvasNode,
  type CanvasOrchestratorInfo,
  type NoteNodeData,
  type TaskNodeData
} from '@renderer/canvasGraph'
import type { VertragusTask } from '@shared/orchestrator'
import LoreName from '@renderer/components/LoreName'
import { summarizeUsage } from '@shared/telemetry'
import { formatTokenCount, formatUsd } from '@renderer/telemetryFormat'
import { terminalTail } from '@renderer/terminalText'
import type { TaskStatus } from '@shared/orchestrator'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import CanvasTerminalDrawer from './CanvasTerminalDrawer'
import { CanvasComposer } from './CanvasComposer'
import { OrchestratorThread } from './OrchestratorThread'

function statusClass(status: TaskStatus): string {
  if (status === 'running') return 'running'
  if (status === 'success') return 'success'
  if (status === 'error' || status === 'needs-work') return 'error'
  return 'idle'
}

function heartbeatText(
  t: TFunction,
  lastHeartbeatAt: number | undefined,
  createdAt: number
): string {
  const base = lastHeartbeatAt ?? createdAt
  const seconds = Math.max(0, Math.floor((Date.now() - base) / 1000))
  if (lastHeartbeatAt == null) return t('canvas.heartbeatPending')
  if (seconds < 60) return t('canvas.heartbeatSeconds', { seconds })
  return t('canvas.heartbeatMinutes', { minutes: Math.floor(seconds / 60) })
}

/** Live plain-text tail of the agent's PTY inside the canvas card. */
function TerminalPeek({ agentId, name }: { agentId: string; name: string }): JSX.Element {
  const { t } = useTranslation()
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    let live = true
    const refresh = (): void => {
      // The peek shows only 6×60 chars; fetch a small tail so the 1.2s poll never
      // serializes the full ~200 KB scrollback over IPC per visible node.
      void window.vertragus.agents
        .bufferTail(agentId, 4_000)
        .then((snapshot) => {
          if (live) setLines(terminalTail(snapshot.data, 6, 60))
        })
        .catch(() => undefined)
    }
    refresh()
    const timer = setInterval(refresh, 1200)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [agentId])

  return (
    <pre
      className="canvas-term"
      aria-label={t('canvas.terminalAria', { name })}
      title={t('canvas.terminalOpen')}
    >
      {lines.length > 0 ? lines.join('\n') : '…'}
      <span className="canvas-term-cursor" aria-hidden="true">
        █
      </span>
    </pre>
  )
}

function TaskNode({ data }: NodeProps<Node<TaskNodeData, 'task'>>): JSX.Element {
  const { t } = useTranslation()
  const { task } = data
  const showToast = useAppStore((state) => state.showToast)
  const [dropActive, setDropActive] = useState(false)

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!task.agentId || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDropActive(true)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDropActive(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    if (!task.agentId) {
      showToast(t('canvas.dropNoAgent'))
      return
    }
    try {
      const path = window.vertragus.files.pathForFile(file)
      if (!path) return
      window.vertragus.agents.write(task.agentId, ` ${path} `)
      showToast(t('canvas.dropSent', { name: task.agentName ?? task.role }))
    } catch {
      // A non-filesystem drop (e.g. browser image) has no path — ignore silently.
    }
  }

  const usage = summarizeUsage(task.usage)
  const usageParts: string[] = []
  if (usage.tokens != null) usageParts.push(`${formatTokenCount(usage.tokens)} Tok`)
  if (usage.costUsd != null) usageParts.push(formatUsd(usage.costUsd))
  const running = task.status === 'running'

  return (
    <div
      className={`canvas-node canvas-node--task ${statusClass(task.status)} ${dropActive ? 'drop-target' : ''}`}
      title={task.agentId ? t('canvas.dropHint', { name: task.agentName ?? task.role }) : undefined}
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      <Handle type="target" position={Position.Left} className="canvas-handle" />
      <div className="canvas-node__head">
        <span className={`canvas-node__dot ${statusClass(task.status)}`} />
        <span className="canvas-node__title" title={task.title}>
          {task.title}
        </span>
        <span
          className={`canvas-node__gate ${trustSignal(task)}`}
          role="img"
          aria-label={t(`canvas.gate.${trustSignal(task)}`)}
          title={t(`canvas.gate.${trustSignal(task)}`)}
        />
        <span className="canvas-node__status">{t(`canvas.status.${task.status}`)}</span>
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
      {running && task.agentId && (
        <TerminalPeek agentId={task.agentId} name={task.agentName ?? task.role} />
      )}
      <div className="canvas-node__foot">
        {running && <span>{heartbeatText(t, task.lastHeartbeatAt, task.createdAt)}</span>}
        {usageParts.length > 0 && <span>{usageParts.join(' · ')}</span>}
        {!running && task.note && (
          <span className="canvas-node__note" title={task.note}>
            {task.note}
          </span>
        )}
      </div>
      {(task.commit ||
        task.judgeReason ||
        task.preflight ||
        task.autoPrStatus ||
        task.remoteCiStatus ||
        (task.findings?.length ?? 0) > 0) && (
        <details className="canvas-evidence" onPointerDown={(event) => event.stopPropagation()}>
          <summary>{t('canvas.evidence.summary')}</summary>
          <dl>
            {task.commit && (
              <>
                <dt>{t('canvas.evidence.commit')}</dt>
                <dd>
                  <code>{task.commit.slice(0, 10)}</code>
                </dd>
              </>
            )}
            {task.preflight && (
              <>
                <dt>{t('canvas.evidence.preflight')}</dt>
                <dd>
                  {task.preflight.checks.filter((check) => check.status === 'passed').length}/
                  {task.preflight.checks.length}
                </dd>
              </>
            )}
            {task.judgeReason && (
              <>
                <dt>{t('canvas.evidence.judge')}</dt>
                <dd title={task.judgeReason}>{task.judgeReason}</dd>
              </>
            )}
            {task.autoPrStatus && (
              <>
                <dt>{t('canvas.evidence.autoPr')}</dt>
                <dd>{task.autoPrStatus}</dd>
              </>
            )}
            {task.remoteCiStatus && (
              <>
                <dt>{t('canvas.evidence.remoteCi')}</dt>
                <dd>{task.remoteCiStatus}</dd>
              </>
            )}
            {(task.findings?.length ?? 0) > 0 && (
              <>
                <dt>{t('canvas.evidence.findings')}</dt>
                <dd>{task.findings!.length}</dd>
              </>
            )}
          </dl>
        </details>
      )}
      <Handle type="source" position={Position.Right} className="canvas-handle" />
    </div>
  )
}

function OrchestratorNode({ data }: NodeProps<Node<CanvasOrchestratorInfo, 'orchestrator'>>): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="canvas-node canvas-node--orchestrator">
      <div className="canvas-node__head">
        <span className={`canvas-node__dot orchestrator ${data.goalActive ? 'running' : ''}`} />
        <LoreName name={data.name} className="canvas-node__title" />
        <span className="canvas-node__status">{t('canvas.orchestrator')}</span>
      </div>
      <div className="canvas-node__meta">
        {data.goalActive ? t('canvas.planning', { count: data.taskCount }) : t('canvas.noGoal')}
        {data.model ? ` · ${data.model}` : ''}
      </div>
      {data.goalTitle && (
        <div className="canvas-node__foot">
          <span className="canvas-node__goal" title={data.goalTitle}>
            {t('canvas.goal', { title: data.goalTitle })}
          </span>
        </div>
      )}
      {data.activity && <div className="canvas-hub-activity" aria-live="polite">{data.activity}</div>}
      {data.agentId && <TerminalPeek agentId={data.agentId} name={data.name} />}
      <Handle type="source" position={Position.Right} className="canvas-handle" />
    </div>
  )
}

function NoteNode({ data }: NodeProps<Node<NoteNodeData, 'note'>>): JSX.Element {
  const { t } = useTranslation()
  const { finding } = data
  return (
    <div className={`canvas-node canvas-node--note kind-${finding.kind}`}>
      <Handle type="target" position={Position.Left} className="canvas-handle" />
      <div className="canvas-node__head">
        <span className="canvas-note__kind">{t(`canvas.kind.${finding.kind}`)}</span>
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
  const { t } = useTranslation()
  // Pick exactly the fields/actions the board reads; the activity summary/phase
  // are picked as primitives so the graph memo below can depend on them.
  const store = useAppStore(
    useShallow((s) => ({
      agents: s.agents,
      profiles: s.profiles,
      activeProfileId: s.activeProfileId,
      activeWorkspaceSessionId: s.activeWorkspaceSessionId,
      tasks: s.orchestrator.tasks,
      goal: s.orchestrator.goal,
      findings: s.orchestrator.findings,
      activitySummary: s.orchestrator.activity?.summary,
      activityPhase: s.orchestrator.activity?.phase,
      setSelectedAgent: s.setSelectedAgent,
      showToast: s.showToast,
      startAll: s.startAll
    }))
  )
  const tasks = store.tasks
  const goal = store.goal
  const boardKey = canvasBoardKey(store.activeProfileId, store.activeWorkspaceSessionId ?? undefined)
  const positions = useCanvasStore(selectBoardPositions(boardKey))
  const setPosition = useCanvasStore((state) => state.setPosition)
  const [drawerAgentId, setDrawerAgentId] = useState<string | null>(null)

  const orchAgent = workspaceAgents(store).find((agent) => agent.kind === 'orchestrator')
  const orchestrator: CanvasOrchestratorInfo | null = orchAgent
    ? {
        agentId: orchAgent.id,
        name: orchAgent.name,
        model: orchAgent.model,
        goalTitle: goal?.title,
        goalActive: Boolean(goal?.active),
        taskCount: tasks.length,
        activity: store.activitySummary,
        status: store.activityPhase
      }
    : null

  const findings = store.findings
  const graph = useMemo(
    () => buildCanvasGraph(tasks, orchestrator, findings ?? [], positions),
    // Positions are intentionally applied only on rebuilds; live drags update
    // the store on drag-stop and survive via mergeNodePositions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      tasks,
      findings,
      orchAgent?.id,
      orchAgent?.name,
      orchAgent?.model,
      goal?.title,
      goal?.active,
      store.activitySummary,
      store.activityPhase
    ]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  useEffect(() => {
    setNodes((previous) => mergeNodePositions(previous, graph.nodes))
  }, [graph, setNodes])

  const onNodeDragStop: OnNodeDrag<CanvasNode> = (_event, node) => {
    setPosition(boardKey, node.id, { x: node.position.x, y: node.position.y })
  }

  const [menu, setMenu] = useState<{ x: number; y: number; task: VertragusTask } | null>(null)

  const onNodeContextMenu: NodeMouseHandler<CanvasNode> = (event, node) => {
    if (node.type !== 'task') return
    event.preventDefault()
    const host = (event.currentTarget as HTMLElement | null)
      ?.closest('.vertragus-canvas')
      ?.getBoundingClientRect()
    setMenu({
      x: event.clientX - (host?.left ?? 0),
      y: event.clientY - (host?.top ?? 0),
      task: node.data.task
    })
  }

  const runMenuAction = (action: () => Promise<unknown>): void => {
    setMenu(null)
    void action().catch(() => store.showToast(t('canvas.menu.failed')))
  }

  const sessionId = store.activeWorkspaceSessionId
  const menuTask = menu?.task

  const onNodeDoubleClick: NodeMouseHandler<CanvasNode> = (_event, node) => {
    const agentId =
      node.type === 'task'
        ? node.data.task.agentId
        : node.type === 'orchestrator'
          ? node.data.agentId
          : undefined
    if (typeof agentId === 'string' && agentId) {
      store.setSelectedAgent(agentId)
      setDrawerAgentId(agentId)
    }
  }

  if (tasks.length === 0 && !orchestrator) {
    return (
      <div className="canvas-empty" role="status">
        <SessionChips />
        <div className="canvas-empty-hero">
          <div className="big">{t('canvas.emptyTitle')}</div>
          <div className="canvas-empty-profile">{store.profiles.find((p) => p.id === store.activeProfileId)?.name ?? '—'}</div>
          <div>{t('canvas.emptyHint')}</div>
          <div className="canvas-empty-actions">
            <button type="button" className="clean-btn workspace-start-btn" onClick={() => void store.startAll()}>{t('canvas.empty.start', { defaultValue: 'Team starten' })}</button>
            <button type="button" className="clean-btn" onClick={() => void window.vertragus.demo.play()}>{t('canvas.empty.playground', { defaultValue: 'Playground' })}</button>
          </div>
          <ol className="canvas-onboarding">
            <li>{t('canvas.empty.drag', { defaultValue: 'Karten frei anordnen' })}</li>
            <li>{t('canvas.empty.doubleClick', { defaultValue: 'Doppelklick öffnet das Terminal' })}</li>
            <li>{t('canvas.empty.chat', { defaultValue: 'Unten mit Caronte chatten' })}</li>
          </ol>
        </div>
        <CanvasComposerMount />
      </div>
    )
  }

  return (
    <div className="vertragus-canvas" aria-label={t('canvas.aria')}>
      <SessionChips />
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={() => setMenu(null)}
        onMoveStart={() => setMenu(null)}
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
      {menu && menuTask && sessionId && (
        <div className="canvas-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          {menuTask.status === 'running' && (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                runMenuAction(() =>
                  window.vertragus.orchestrator.pauseTask(store.activeProfileId, sessionId, menuTask.id)
                )
              }
            >
              ⏸ {t('canvas.menu.pause')}
            </button>
          )}
          {menuTask.status === 'paused' && (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                runMenuAction(() =>
                  window.vertragus.orchestrator.resumeTask(store.activeProfileId, sessionId, menuTask.id)
                )
              }
            >
              ▶ {t('canvas.menu.resume')}
            </button>
          )}
          {menuTask.interrupted && (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                runMenuAction(() =>
                  window.vertragus.orchestrator.resumeInterruptedTask(
                    store.activeProfileId,
                    sessionId,
                    menuTask.id
                  )
                )
              }
            >
              ▶ {t('canvas.menu.resumeInterrupted')}
            </button>
          )}
          {(menuTask.status === 'running' ||
            menuTask.status === 'paused' ||
            menuTask.status === 'error') && (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                runMenuAction(() =>
                  window.vertragus.orchestrator.fallbackTask(store.activeProfileId, sessionId, menuTask.id)
                )
              }
            >
              ♻ {t('canvas.menu.fallback')}
            </button>
          )}
          {menuTask.agentId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null)
                store.setSelectedAgent(menuTask.agentId!)
                setDrawerAgentId(menuTask.agentId!)
              }}
            >
              ⌨ {t('canvas.menu.focus')}
            </button>
          )}
        </div>
      )}
      <CanvasTerminalDrawer agent={store.agents.find((agent) => agent.id === drawerAgentId) ?? null} onClose={() => setDrawerAgentId(null)} />
      <div className="canvas-composer-slot" />
    </div>
  )
}

function SessionChips(): JSX.Element {
  const { t } = useTranslation()
  const store = useAppStore(
    useShallow((s) => ({
      workspaceSessions: s.workspaceSessions,
      activeProfileId: s.activeProfileId,
      activeWorkspaceSessionId: s.activeWorkspaceSessionId,
      selectWorkspaceSession: s.selectWorkspaceSession,
      startAll: s.startAll
    }))
  )
  const sessions = store.workspaceSessions.filter((session) => session.profileId === store.activeProfileId)
  return (
    <nav className="canvas-sessions" aria-label={t('canvas.sessions.aria', { defaultValue: 'Workspace-Sessions' })}>
      {sessions.map((session) => (
        <button key={session.id} type="button" className={session.id === store.activeWorkspaceSessionId ? 'active' : ''} onClick={() => void store.selectWorkspaceSession(session.profileId, session.id)} title={session.taskSummary}>
          W{session.sequence} · {session.name}
        </button>
      ))}
      <button type="button" className="canvas-session-add" onClick={() => void store.startAll()} aria-label={t('canvas.sessions.add', { defaultValue: 'Weitere Session starten' })}>＋</button>
    </nav>
  )
}

/**
 * Integrator mount for the WS-B canvas chat: the orchestrator thread + composer
 * live in the canvas' bottom-centre slot (`.canvas-composer-slot`). Props are
 * sourced from the app store so the slot works in both the empty-state and the
 * populated board.
 */
function CanvasComposerMount(): JSX.Element {
  const store = useAppStore(
    useShallow((s) => {
      const profileId = s.activeProfileId
      const workspaceSessionId = s.activeWorkspaceSessionId ?? undefined
      return {
        profileId,
        workspaceSessionId,
        orchestrator: s.orchestrator,
        reviewPendingPlan: s.reviewPendingPlan,
        startAll: s.startAll,
        // Derive the boolean so usage-only agent ticks don't re-render the slot.
        orchestratorRunning: s.agents.some(
          (agent) =>
            agent.kind === 'orchestrator' &&
            (agent.status === 'running' || agent.status === 'waiting') &&
            (!agent.profileId || agent.profileId === profileId) &&
            (!workspaceSessionId || agent.workspaceSessionId === workspaceSessionId)
        )
      }
    })
  )
  return (
    <div className="canvas-composer-slot">
      <OrchestratorThread
        profileId={store.profileId}
        workspaceSessionId={store.workspaceSessionId}
        snapshot={store.orchestrator}
        reviewPendingPlan={store.reviewPendingPlan}
      />
      <CanvasComposer
        profileId={store.profileId}
        workspaceSessionId={store.workspaceSessionId}
        orchestratorRunning={store.orchestratorRunning}
        startAll={store.startAll}
      />
    </div>
  )
}
