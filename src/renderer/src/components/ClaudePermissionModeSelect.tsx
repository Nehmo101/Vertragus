import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  return (
    <select
      id={id}
      className="select"
      aria-label={t('ui.claudePermission.aria')}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as ClaudePermissionMode)}
    >
      {CLAUDE_PERMISSION_MODES.map((mode) => (
        <option key={mode} value={mode}>
          {t(`ui.claudePermission.mode.${mode}`, {
            defaultValue: CLAUDE_PERMISSION_MODE_LABELS[mode]
          })}
        </option>
      ))}
    </select>
  )
}
