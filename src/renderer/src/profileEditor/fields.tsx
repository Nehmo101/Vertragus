import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EFFORT_LEVELS } from '@shared/schema/provider'
import type { ModelDiscoveryResult, ProviderListEntry } from '../../../preload'
import { NEW_PROVIDER_VALUE } from '../providerEditor/model'
import { filterModelOptions, modelComboStatus, modelOptions, type EffortChoice } from './model'

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

interface SwitchFieldProps {
  label: string
  hint?: string
  checked: boolean
  onChange(checked: boolean): void
}

/**
 * A boolean the other way round from {@link Field}: label beside the control,
 * not above it. A switch whose caption sits in the uppercase field-label rail
 * reads as a section heading and gets skipped over.
 */
export function SwitchField({ label, hint, checked, onChange }: SwitchFieldProps): React.JSX.Element {
  return (
    <label className="pe-switch">
      <input
        type="checkbox"
        className="pe-switch-input"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="pe-switch-text">
        <span className="pe-switch-label">{label}</span>
        {hint ? <span className="pe-hint">{hint}</span> : null}
      </span>
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
 *
 * The way into the provider editor lives here rather than in the two call
 * sites, so the orchestrator row and every slot row get it by construction:
 * a last "+ Eigener Provider …" entry for a CLI Vertragus has never heard of,
 * and a pencil beside the box for the one currently selected. The moment you
 * notice a provider is missing or mis-declared is the moment you are looking
 * at this dropdown.
 */
export function ProviderSelect({
  value,
  providers,
  loading,
  onChange,
  className
}: ProviderSelectProps): React.JSX.Element {
  const { t } = useTranslation()
  const known = providers.some((entry) => entry.config.id === value)
  const openEditor = (providerId?: string): void => {
    void window.vertragus?.app.openProviderEditor(providerId)
  }
  return (
    <div className="pe-provider">
      <select
        className={className ?? 'pe-input'}
        value={value}
        onChange={(event) => {
          if (event.target.value === NEW_PROVIDER_VALUE) {
            // Opens an EMPTY editor; the selection stays where it was, so a
            // cancelled "new provider" does not silently repoint the slot.
            openEditor()
            return
          }
          onChange(event.target.value)
        }}
      >
        {!known && value ? (
          <option value={value}>{loading ? t('common.loading') : value}</option>
        ) : null}
        {providers.map((entry) => (
          <option key={entry.config.id} value={entry.config.id}>
            {entry.config.label}
            {entry.health && !entry.health.available
              ? ` — ${t('profileEditor.providerUnavailable', {
                  detail: entry.health.error ?? entry.health.detail ?? ''
                })}`
              : ''}
          </option>
        ))}
        <option value={NEW_PROVIDER_VALUE}>{t('profileEditor.customProvider')}</option>
      </select>
      <button
        type="button"
        className="pe-icon-button pe-provider-edit"
        title={t('profileEditor.editProvider')}
        aria-label={t('profileEditor.editProvider')}
        disabled={!known}
        onClick={() => openEditor(value)}
      >
        <PencilIcon />
      </button>
    </div>
  )
}

/** Small pencil for "edit this record"; matches the panel's icon weight. */
function PencilIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M11.2 2.3a1.1 1.1 0 0 1 1.6 0l0.9 0.9a1.1 1.1 0 0 1 0 1.6L6.4 11.9l-3 0.7 0.7-3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface EffortSelectProps {
  value: EffortChoice
  onChange(value: EffortChoice): void
  className?: string
}

export function EffortSelect({ value, onChange, className }: EffortSelectProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <select
      className={className ?? 'pe-input'}
      value={value}
      onChange={(event) => onChange(event.target.value as EffortChoice)}
    >
      <option value="">{t('profileEditor.effortDefault')}</option>
      {EFFORT_LEVELS.map((level) => (
        <option key={level} value={level}>
          {t(`profileEditor.effortLevel.${level}`)}
        </option>
      ))}
    </select>
  )
}

interface ModelComboProps {
  value: string
  catalogue: ModelDiscoveryResult | undefined
  /** Discovery for this provider is still running. */
  loading?: boolean
  onChange(model: string): void
  /** Re-run discovery for this provider (CLI installed or logged in since). */
  onReload?(): void
  className?: string
  placeholder?: string
  /** Slot rows only show the status line when something is actually wrong. */
  quietWhenHealthy?: boolean
}

/**
 * Free text WITH a real dropdown — never a closed list, and never an invisible
 * one either.
 *
 * Two failures produced the same symptom ("I cannot pick a model"): a native
 * `<datalist>` whose only affordance is a hover-only Chromium arrow, and a
 * discovery that answered with nothing. So this control renders its own list
 * behind a visible ▾ button, keeps the input typable at all times (a model
 * released today must be usable today), and states underneath where the
 * suggestions came from — or why there are none.
 */
export function ModelCombo({
  value,
  catalogue,
  loading = false,
  onChange,
  onReload,
  className,
  placeholder,
  quietWhenHealthy = false
}: ModelComboProps): React.JSX.Element {
  const { t } = useTranslation()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const options = useMemo(() => (catalogue ? modelOptions(catalogue.models) : []), [catalogue])
  const matches = useMemo(() => filterModelOptions(options, value), [options, value])
  const status = modelComboStatus(t, catalogue, loading)
  const showStatus = !quietWhenHealthy || status.tone !== 'ok'

  return (
    <div
      className="pe-combo"
      onBlur={(event) => {
        // Closing on every blur would swallow the click on an option itself.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <div className="pe-combo-row">
        <input
          className={className ?? 'pe-input pe-mono'}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={t('profileEditor.model')}
          title={status.title}
          value={value}
          spellCheck={false}
          placeholder={placeholder ?? t('profileEditor.modelPlaceholder')}
          onChange={(event) => {
            onChange(event.target.value)
            if (options.length > 0) setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              event.stopPropagation()
              setOpen(false)
            }
            if (event.key === 'ArrowDown' && options.length > 0) setOpen(true)
          }}
        />
        <button
          type="button"
          className="pe-combo-toggle"
          title={t('profileEditor.modelsOpen')}
          aria-label={t('profileEditor.modelsOpen')}
          disabled={options.length === 0}
          onClick={() => setOpen((current) => !current)}
        >
          ▾
        </button>
        {onReload ? (
          <button
            type="button"
            className="pe-combo-reload"
            title={t('profileEditor.modelsReload')}
            aria-label={t('profileEditor.modelsReload')}
            onClick={() => {
              setOpen(false)
              onReload()
            }}
          >
            ⟳
          </button>
        ) : null}

        {/* Inside the row so it hangs off the FIELD, not off the status line —
            a two-line status must not push the list away from its input. */}
        {open && options.length > 0 ? (
          <ul className="pe-combo-list" id={listId} role="listbox">
          {matches.length === 0 ? (
            <li className="pe-combo-empty">{t('profileEditor.modelsNoMatch')}</li>
          ) : (
            matches.map((model) => (
              <li key={model}>
                <button
                  type="button"
                  role="option"
                  aria-selected={model === value}
                  className={model === value ? 'pe-combo-option is-active' : 'pe-combo-option'}
                  onClick={() => {
                    onChange(model)
                    setOpen(false)
                  }}
                >
                  {model}
                </button>
              </li>
            ))
          )}
          </ul>
        ) : null}
      </div>

      {showStatus ? (
        <span className={`pe-combo-status is-${status.tone}`} title={status.title}>
          {status.text}
        </span>
      ) : null}
    </div>
  )
}
