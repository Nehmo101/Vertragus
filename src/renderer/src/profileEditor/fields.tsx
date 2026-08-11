import { useId } from 'react'
import { EFFORT_LEVELS } from '@shared/schema/provider'
import type { ModelDiscoveryResult, ProviderListEntry } from '../../../preload'
import { modelOptions, type EffortChoice } from './model'
import { EDITOR_STRINGS } from './strings'

interface FieldProps {
  label: string
  error?: string
  hint?: string
  children: React.ReactNode
}

/** Label, control, and — when there is one — the reason it was rejected. */
export function Field({ label, error, hint, children }: FieldProps): React.JSX.Element {
  return (
    <label className="pe-field">
      <span className="pe-field-label">{label}</span>
      {children}
      {error ? <span className="pe-error">{error}</span> : null}
      {!error && hint ? <span className="pe-hint">{hint}</span> : null}
    </label>
  )
}

interface ProviderSelectProps {
  value: string
  providers: ProviderListEntry[]
  loading: boolean
  onChange(providerId: string): void
  className?: string
}

/**
 * Provider picker. An unhealthy CLI stays selectable — it may simply not be
 * installed on THIS machine yet — but says so, because a launch that fails
 * three minutes later with "command not found" is the worse surprise.
 */
export function ProviderSelect({
  value,
  providers,
  loading,
  onChange,
  className
}: ProviderSelectProps): React.JSX.Element {
  const known = providers.some((entry) => entry.config.id === value)
  return (
    <select
      className={className ?? 'pe-input'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {!known && value ? <option value={value}>{loading ? EDITOR_STRINGS.loading : value}</option> : null}
      {providers.map((entry) => (
        <option key={entry.config.id} value={entry.config.id}>
          {entry.config.label}
          {entry.health && !entry.health.available
            ? ` — ${EDITOR_STRINGS.providerUnavailable(entry.health.error ?? entry.health.detail ?? '')}`
            : ''}
        </option>
      ))}
    </select>
  )
}

interface EffortSelectProps {
  value: EffortChoice
  onChange(value: EffortChoice): void
  className?: string
}

const EFFORT_LABELS: Record<string, string> = {
  low: EDITOR_STRINGS.effortLow,
  medium: EDITOR_STRINGS.effortMedium,
  high: EDITOR_STRINGS.effortHigh
}

export function EffortSelect({ value, onChange, className }: EffortSelectProps): React.JSX.Element {
  return (
    <select
      className={className ?? 'pe-input'}
      value={value}
      onChange={(event) => onChange(event.target.value as EffortChoice)}
    >
      <option value="">{EDITOR_STRINGS.effortDefault}</option>
      {EFFORT_LEVELS.map((level) => (
        <option key={level} value={level}>
          {EFFORT_LABELS[level]}
        </option>
      ))}
    </select>
  )
}

interface ModelComboProps {
  value: string
  catalogue: ModelDiscoveryResult | undefined
  onChange(model: string): void
  className?: string
  placeholder?: string
}

/**
 * Free text with suggestions — never a closed list. Discovery can be empty
 * (CLI not installed, cache cold) and a brand-new model must be typeable the
 * day it ships, so the datalist assists and never restricts.
 */
export function ModelCombo({
  value,
  catalogue,
  onChange,
  className,
  placeholder
}: ModelComboProps): React.JSX.Element {
  const listId = useId()
  const options = catalogue ? modelOptions(catalogue.models) : []
  return (
    <>
      <input
        className={className ?? 'pe-input pe-mono'}
        list={options.length > 0 ? listId : undefined}
        value={value}
        spellCheck={false}
        placeholder={placeholder ?? EDITOR_STRINGS.modelPlaceholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {options.length > 0 ? (
        <datalist id={listId}>
          {options.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ) : null}
    </>
  )
}
