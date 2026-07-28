import { useTranslation } from 'react-i18next'
import type { AgentSlot } from '@shared/profile'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './help'

export type MultiAgentOverrideChoice = 'inherit' | 'on' | 'off'

export function multiAgentOverrideChoice(value: boolean | undefined): MultiAgentOverrideChoice {
  return value === undefined ? 'inherit' : value ? 'on' : 'off'
}

export function slotWithMultiAgentOverride(
  slot: AgentSlot,
  choice: MultiAgentOverrideChoice
): AgentSlot {
  const next = { ...slot }
  if (choice === 'inherit') {
    delete next.multiAgent
  } else {
    next.multiAgent = choice === 'on'
  }
  return next
}

export function effectiveMultiAgentEnabled(slot: AgentSlot, globalEnabled: boolean): boolean {
  return slot.multiAgent ?? globalEnabled
}

interface MultiAgentOverrideSelectProps {
  id: string
  value: boolean | undefined
  globalEnabled: boolean
  onChange: (choice: MultiAgentOverrideChoice) => void
}

export function MultiAgentOverrideSelect({
  id,
  value,
  globalEnabled,
  onChange
}: MultiAgentOverrideSelectProps): JSX.Element {
  const { t } = useTranslation()
  const statusId = `${id}-status`
  const effectiveEnabled = value ?? globalEnabled
  const stateLabel = (enabled: boolean): string =>
    enabled ? t('profile.multiAgent.on') : t('profile.multiAgent.off')

  return (
    <div className="slot-path-row">
      <div className="slot-path-field">
        <label className="field-label slot-col-label" htmlFor={id}>
          {t('profile.multiAgent.label')} <InfoTip text={t(HELP.multiAgent)} />
        </label>
        <select
          id={id}
          className="slot-select-sm"
          value={multiAgentOverrideChoice(value)}
          aria-describedby={statusId}
          onChange={(event) => onChange(event.currentTarget.value as MultiAgentOverrideChoice)}
        >
          <option value="inherit">
            {t('profile.multiAgent.inherit', { state: stateLabel(globalEnabled) })}
          </option>
          <option value="on">{t('profile.multiAgent.on')}</option>
          <option value="off">{t('profile.multiAgent.off')}</option>
        </select>
        <div className="model-effective" id={statusId} aria-live="polite">
          {t('profile.multiAgent.effective', { state: stateLabel(effectiveEnabled) })}
          {' · '}
          {value === undefined
            ? t('profile.multiAgent.inherited')
            : t('profile.multiAgent.override', { state: stateLabel(globalEnabled) })}
        </div>
      </div>
    </div>
  )
}
