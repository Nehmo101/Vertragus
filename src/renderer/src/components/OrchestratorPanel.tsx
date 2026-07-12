import { useEffect, useRef, useState } from 'react'
import { useAppStore, activeProfile } from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import LimitsPanel from '@renderer/components/LimitsPanel'
import type { OrcaTask, TaskStatus } from '@shared/orchestrator'

function useClock(): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now.toTimeString().slice(0, 8)
}

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8)
}

const TASK_PILL: Record<TaskStatus, { bg: string; fg: string; dot: string; label: string }> = {
  queued: { bg: 'rgba(255,255,255,0.06)', fg: '#8b98ad', dot: '#5b697f', label: 'geplant' },
  running: { bg: 'rgba(63,209,122,0.14)', fg: '#5fe39a', dot: '#3fd17a', label: 'läuft' },
  success: { bg: 'rgba(63,209,122,0.14)', fg: '#5fe39a', dot: '#3fd17a', label: 'fertig' },
  error: { bg: 'rgba(242,85,90,0.15)', fg: '#ff7377', dot: '#f2555a', label: 'Fehler' },
  stopped: { bg: 'rgba(91,105,127,0.16)', fg: '#8a96a8', dot: '#5b697f', label: 'gestoppt' }
}

function TaskCard({ task }: { task: OrcaTask }): JSX.Element {
  const pill = TASK_PILL[task.status]
  const chip = task.provider ? PROVIDER_THEME[task.provider] : undefined
  const label = task.status === 'running' && task.yolo ? 'läuft · yolo' : pill.label
  return (
    <div className="dag-item">
      <div className="dag-rail">
        <span
          className="dag-node"
          style={{ background: pill.dot, boxShadow: `0 0 7px ${pill.dot}` }}
        />
        <span className="dag-line" />
      </div>
      <div className="task-card">
        <div className="task-row1">
          <span
            className="task-dot"
            style={{ background: pill.dot, boxShadow: `0 0 6px ${pill.dot}` }}
          />
          <span className="task-title">{task.title}</span>
          <span className="task-id">{task.id}</span>
        </div>
        <div className="task-row2">
          <span className="assignee">
            <span
              className="assignee-dot"
              style={{ background: chip?.fg ?? '#5b697f' }}
            />
            {task.agentName ? `${task.agentName} · ${task.role}` : task.role}
            {task.model ? ` · ${task.model}` : ''}
          </span>
          <span className="spacer" />
          <span className="task-pill" style={{ background: pill.bg, color: pill.fg }}>
            {label}
          </span>
        </div>
        {task.status === 'running' && (
          <div className="task-bar">
            <div className="task-bar-fill indeterminate" />
          </div>
        )}
        {task.note && (
          <div className={`task-note ${task.status === 'error' ? 'err' : ''}`}>{task.note}</div>
        )}
        {(task.prUrl || task.autoPrStatus) && (
          <div className="task-pr-row">
            <span>Auto-PR: {task.autoPrStatus ?? 'unbekannt'}</span>
            {task.prUrl && (
              <a href={task.prUrl} target="_blank" rel="noreferrer">
                Pull Request oeffnen
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function OrchestratorPanel(): JSX.Element {
  const store = useAppStore()
  const clock = useClock()
  const profile = activeProfile(store)
  const orch = store.agents.find((a) => a.kind === 'orchestrator')
  const { goal, tasks, pendingPlan } = store.orchestrator
  const logRef = useRef<HTMLDivElement>(null)

  const done = tasks.filter((t) => t.status === 'success').length
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0
  const assigned = tasks.filter((t) => t.agentId).length

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [store.events.length])

  return (
    <section className="orch-panel">
      <LimitsPanel />
      <div className="orch-head">
        <div className="orch-head-row">
          <span className="orch-diamond">◇</span>
          <span className="orch-title">Orchestrator</span>
          <span className="orch-model">{orch?.model ?? profile?.orchestrator?.model ?? '—'}</span>
          <div className="spacer" />
          <span className="mini-toggle-label">{goal?.active ? 'aktiv' : 'inaktiv'}</span>
          <span className={`mini-toggle ${goal?.active ? '' : 'off'}`}>
            <span className="knob" />
          </span>
        </div>

        <div className="goal-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="goal-caption">Aktuelles Ziel</span>
            <span className="goal-id">{goal?.id ?? '—'}</span>
          </div>
          {goal ? (
            <>
              <div className="goal-title">{goal.title}</div>
              <div className="goal-bar">
                <div className="goal-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="goal-stats">
                <span>
                  {tasks.length} Subtasks · {assigned} zugewiesen
                </span>
                <span className="pct">{pct}%</span>
              </div>
            </>
          ) : (
            <>
              <div className="goal-title">Kein aktives Ziel</div>
              <div className="goal-note">
                „▶ Alle starten" aktiviert den Orchestrator ({profile?.orchestrator?.provider ?? '—'}
                /{profile?.orchestrator?.model ?? '—'}). Gib ihm im Terminal ein Ziel — er zerlegt es
                und delegiert an Subagents.
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="dag-caption">
          <span>Aufgaben-Zerlegung</span>
          <span className="tag">DAG</span>
        </div>
        {pendingPlan && (
          <div className="plan-review" role="status" aria-live="polite">
            <div className="plan-review-head">
              <div>
                <strong>Plan wartet auf Freigabe</strong>
                <span>
                  {pendingPlan.plan.tasks.length} Aufgaben, maximal{' '}
                  {pendingPlan.plan.maxParallel} parallel
                </span>
              </div>
              <code>{pendingPlan.planId}</code>
            </div>
            <ol>
              {pendingPlan.plan.tasks.map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  <span>{task.role}</span>
                </li>
              ))}
            </ol>
            {pendingPlan.validationIssues.length > 0 && (
              <div className="plan-review-warning">
                Der Vorschlag wurde sicher normalisiert. Bitte vor dem Start pruefen.
              </div>
            )}
            <div className="plan-review-actions">
              <button type="button" className="btn ghost" onClick={() => void window.orca.orchestrator.reviewPlan(false)}>
                Ablehnen
              </button>
              <button type="button" className="btn primary" onClick={() => void window.orca.orchestrator.reviewPlan(true)}>
                Plan starten
              </button>
            </div>
          </div>
        )}
        <div className="dag-scroll">
          {tasks.length === 0 ? (
            <div className="dag-empty">
              Noch keine Aufgaben. Sobald der Orchestrator <code>dispatch_subagent</code> aufruft,
              erscheinen hier die Teilaufgaben live — jede läuft als echter Subagent im Grid.
            </div>
          ) : (
            tasks.map((task) => <TaskCard key={task.id} task={task} />)
          )}
        </div>

        <div className="dispatch">
          <div className="dispatch-head">
            <span className="caption">Dispatch-Protokoll</span>
            <span className="dot" />
            <div className="spacer" />
            <span className="clock">{clock}</span>
          </div>
          <div className="dispatch-body" ref={logRef}>
            {store.events.length === 0 && (
              <div className="dispatch-line tone-muted">— bereit —</div>
            )}
            {store.events.map((evt, i) => (
              <div key={i} className={`dispatch-line tone-${evt.tone}`}>
                <span className="time">{fmtTime(evt.time)}</span> {evt.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
