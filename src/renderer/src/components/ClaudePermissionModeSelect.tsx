import {
  CLAUDE_PERMISSION_MODE_LABELS,
  CLAUDE_PERMISSION_MODES,
  type ClaudePermissionMode
} from '@shared/claudePermissionMode'

interface ClaudePermissionModeSelectProps {
  value: ClaudePermissionMode
  onChange: (mode: ClaudePermissionMode) => void
  id?: string
  disabled?: boolean
}

export default function ClaudePermissionModeSelect({
  value,
  onChange,
  id,
  disabled = false
}: ClaudePermissionModeSelectProps): JSX.Element {
  return (
    <select
      id={id}
      className="select"
      aria-label="Claude-Berechtigungsmodus"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as ClaudePermissionMode)}
    >
      {CLAUDE_PERMISSION_MODES.map((mode) => (
        <option key={mode} value={mode}>
          {CLAUDE_PERMISSION_MODE_LABELS[mode]}
        </option>
      ))}
    </select>
  )
}
