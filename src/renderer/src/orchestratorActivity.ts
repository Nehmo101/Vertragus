import type {
  OrcaTask,
  OrchestratorActivity,
  OrchestratorActivityPhase,
  OrchestratorSnapshot,
  TaskPhase
} from '@shared/orchestrator'

export const ORCHESTRATOR_ACTIVITY_LABEL: Record<OrchestratorActivityPhase, string> = {
  idle: 'bereit',
  planning: 'plant',
  'awaiting-review': 'wartet auf Freigabe',
  delegating: 'delegiert',
  monitoring: 'überwacht',
  reviewing: 'prüft',
  integrating: 'integriert',
  summarizing: 'fasst zusammen',
  completed: 'abgeschlossen',
  blocked: 'blockiert'
}

export const TASK_PHASE_LABEL: Record<TaskPhase, string> = {
  queued: 'Wartet',
  preflight: 'Preflight',
  starting: 'Startet',
  working: 'Arbeitet',
  testing: 'Prüft',
  committing: 'Commit',
  integrating: 'Integriert',
  'security-review': 'Security-Review',
  completed: 'Abgeschlossen'
}

function taskDetails(tasks: OrcaTask[]): string[] {
  return tasks.slice(0, 4).map((task) => {
    const owner = task.agentName ?? task.role
    return `${owner}: ${task.title} · ${task.lastAction ?? task.phase ?? task.status}`
  })
}

export function liveOrchestratorTasks(tasks: OrcaTask[]): OrcaTask[] {
  return tasks.filter((task) => task.status === 'running' || task.status === 'queued')
}

export function taskActivityText(task: OrcaTask): string {
  const phase = task.phase ? TASK_PHASE_LABEL[task.phase] : task.status === 'running' ? 'Arbeitet' : 'Wartet'
  const action = task.lastAction?.trim()
  return action ? `${phase} · ${action}` : phase
}

/**
 * Old persisted snapshots do not have explicit coordinator activity. Derive a
 * truthful fallback from the task graph until report_activity updates them.
 */
export function resolveOrchestratorActivity(
  snapshot: OrchestratorSnapshot,
  now: number = Date.now()
): OrchestratorActivity {
  if (snapshot.activity?.summary.trim()) {
    return {
      ...snapshot.activity,
      details: [...snapshot.activity.details]
    }
  }

  const running = snapshot.tasks.filter((task) => task.status === 'running')
  const queued = snapshot.tasks.filter((task) => task.status === 'queued')
  const updatedAt = Math.max(
    0,
    ...snapshot.tasks.map((task) => task.lastHeartbeatAt ?? task.finishedAt ?? task.createdAt)
  ) || now

  if (snapshot.pendingPlan) {
    return {
      phase: 'awaiting-review',
      summary: `Hat einen Plan mit ${snapshot.pendingPlan.plan.tasks.length} Aufgabe(n) erstellt und wartet auf Freigabe.`,
      details: snapshot.pendingPlan.plan.tasks.slice(0, 4).map((task) => `${task.role}: ${task.title}`),
      nextStep: 'Nach Freigabe die vorgesehenen Subagents starten.',
      updatedAt
    }
  }

  const integration = running.find((task) => task.role === 'integrator')
  if (integration) {
    return {
      phase: 'integrating',
      summary: integration.lastAction || 'Führt die Subagent-Ergebnisse zusammen.',
      details: taskDetails(running),
      nextStep: 'Integration und Qualitätsprüfungen abschließen.',
      updatedAt
    }
  }

  if (running.length > 0 || queued.length > 0) {
    const active = [...running, ...queued]
    return {
      phase: running.length > 0 ? 'monitoring' : 'delegating',
      summary: `Überwacht ${running.length} laufende Subagents; ${queued.length} Aufgabe(n) warten.`,
      details: taskDetails(active),
      nextStep: 'Statuswechsel, Blocker und Ergebnisse prüfen.',
      updatedAt
    }
  }

  if (snapshot.goal?.active && snapshot.tasks.length > 0) {
    const recent = [...snapshot.tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4)
    const failed = recent.filter((task) => task.status === 'error' || task.status === 'needs-work')
    return {
      phase: failed.length > 0 ? 'blocked' : 'summarizing',
      summary: failed.length > 0
        ? 'Prüft fehlgeschlagene Aufgaben und bereitet konkrete nächste Schritte vor.'
        : 'Alle Subagents sind fertig; die Ergebnisse werden zusammengefasst.',
      details: taskDetails(recent),
      nextStep: failed.length > 0 ? 'Blocker erklären.' : 'Abschlussbericht ausgeben.',
      updatedAt
    }
  }

  if (snapshot.goal?.active) {
    return {
      phase: 'planning',
      summary: 'Analysiert das Ziel und entwirft eine passende Aufgabenverteilung.',
      details: [],
      nextStep: 'Subagent-Rollen prüfen und Aufgaben delegieren.',
      updatedAt
    }
  }

  return {
    phase: 'idle',
    summary: 'Der Orchestrator wartet auf ein Ziel.',
    details: [],
    nextStep: 'Im Terminal ein Ziel beschreiben.',
    updatedAt
  }
}
