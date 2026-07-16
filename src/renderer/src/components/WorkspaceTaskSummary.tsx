interface Props {
  taskSummary: string | undefined
}

/** Compact secondary line for the current task of a profile workspace. */
export default function WorkspaceTaskSummary({ taskSummary }: Props): JSX.Element | null {
  const summary = taskSummary?.trim()
  if (!summary) return null

  return (
    <span className="workspace-task-summary" title={summary}>
      {summary}
    </span>
  )
}
