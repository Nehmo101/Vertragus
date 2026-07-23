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
  const statusId = `${id}-status`
  const effectiveEnabled = value ?? globalEnabled

  return (
    <div className="slot-path-row">
      <div className="slot-path-field">
        <label className="field-label slot-col-label" htmlFor={id}>
          Multiagent-Modus <InfoTip text={HELP.multiAgent} />
        </label>
        <select
          id={id}
          className="slot-select-sm"
          value={multiAgentOverrideChoice(value)}
          aria-describedby={statusId}
          onChange={(event) => onChange(event.currentTarget.value as MultiAgentOverrideChoice)}
        >
          <option value="inherit">
            Global erben — aktuell {globalEnabled ? 'Aktiv' : 'Aus'}
          </option>
          <option value="on">Aktiv</option>
          <option value="off">Aus</option>
        </select>
        <div className="model-effective" id={statusId} aria-live="polite">
          Effektiv: {effectiveEnabled ? 'Aktiv' : 'Aus'}
          {' · '}
          {value === undefined
            ? 'globale Einstellung geerbt'
            : `Slot-Override · global ${globalEnabled ? 'Aktiv' : 'Aus'}`}
        </div>
      </div>
    </div>
  )
}
