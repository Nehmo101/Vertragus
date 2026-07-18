import type { ReactNode } from 'react'

export type OrchestratorThreadRowTone = 'user' | 'activity' | 'goal' | 'task' | 'finding' | 'plan'

export interface OrchestratorActivityRowProps {
  tone: OrchestratorThreadRowTone
  title: string
  detail?: string
  timestamp?: number
  children?: ReactNode
}

export function OrchestratorActivityRow({ tone, title, detail, timestamp, children }: OrchestratorActivityRowProps): JSX.Element {
  return (
    <article className={`orchestrator-activity-row tone-${tone}`} data-tone={tone}>
      <span className="orchestrator-activity-marker" aria-hidden="true" />
      <div>
        <header>
          <strong>{title}</strong>
          {timestamp ? <time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> : null}
        </header>
        {detail ? <p>{detail}</p> : null}
        {children}
      </div>
    </article>
  )
}
