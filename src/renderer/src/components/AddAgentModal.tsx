import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModelCatalogStatus from '@renderer/components/ModelCatalogStatus'
import {
  modelPresetAvailability,
  type ProviderModelCatalog
} from '@renderer/modelCatalog'
import { useAppStore } from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import {
  MODEL_PRESETS,
  MODEL_PRESET_LABELS,
  formatModelLabel,
  resolveModel,
  type ModelPreset
} from '@shared/models'
import type { AgentProviderId } from '@shared/providers'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']

function availablePreset(
  provider: AgentProviderId,
  preset: ModelPreset,
  catalog: ProviderModelCatalog
): boolean {
  return modelPresetAvailability(provider, preset, catalog).available
}

function initialPreset(provider: AgentProviderId, catalog: ProviderModelCatalog): ModelPreset | undefined {
  return availablePreset(provider, 'balanced', catalog) ? 'balanced' : undefined
}

export default function AddAgentModal(): JSX.Element | null {
  const { t } = useTranslation()
  const open = useAppStore((state) => state.addAgentOpen)
  const models = useAppStore((state) => state.models)
  const close = useAppStore((state) => state.closeAddAgent)
  const addAgent = useAppStore((state) => state.addAgent)
  const [provider, setProvider] = useState<AgentProviderId>('codex')
  const [model, setModel] = useState('')
  const [modelPreset, setModelPreset] = useState<ModelPreset | undefined>(() =>
    initialPreset('codex', models.codex)
  )
  const [submitting, setSubmitting] = useState(false)

  const catalog = models[provider]
  const effectiveModel = useMemo(
    () => resolveModel(provider, { model, modelPreset }),
    [model, modelPreset, provider]
  )

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close, open, submitting])

  if (!open) return null

  const submit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      await addAgent({ provider, model: model.trim(), modelPreset })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-wrap">
      <div className="modal-scrim" onClick={() => !submitting && close()} />
      <div
        className="modal add-agent-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-agent-title"
      >
        <div className="modal-head">
          <span className="modal-gear">＋</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title" id="add-agent-title">
              {t('modals.addAgent.title')}
            </div>
            <div className="modal-sub">{t('modals.addAgent.sub')}</div>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label={t('modals.addAgent.closeAria')}
            disabled={submitting}
            onClick={close}
          >
            ✕
          </button>
        </div>

        <div className="modal-body add-agent-body">
          <label>
            <span className="field-label">{t('modals.addAgent.provider')}</span>
            <select
              className="slot-select-sm"
              autoFocus
              value={provider}
              onChange={(event) => {
                const next = event.target.value as AgentProviderId
                setProvider(next)
                setModel('')
                setModelPreset(initialPreset(next, models[next]))
              }}
            >
              {AGENT_PROVIDERS.map((item) => (
                <option key={item} value={item}>
                  {PROVIDER_THEME[item].label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="field-label">{t('modals.addAgent.strength')}</span>
            <select
              className="slot-select-sm"
              value={modelPreset ?? ''}
              onChange={(event) =>
                setModelPreset((event.target.value || undefined) as ModelPreset | undefined)
              }
            >
              <option value="">{t('modals.addAgent.cliDefault')}</option>
              {MODEL_PRESETS.map((preset) => {
                const available = availablePreset(provider, preset, catalog)
                return (
                  <option key={preset} value={preset} disabled={!available}>
                    {MODEL_PRESET_LABELS[preset]}
                    {!available ? ` ${t('modals.addAgent.unavailable')}` : ''}
                  </option>
                )
              })}
            </select>
          </label>

          <label>
            <span className="field-label">{t('modals.addAgent.model')}</span>
            <input
              className="slot-select-sm mono"
              list="add-agent-models"
              placeholder={t('modals.addAgent.modelPlaceholder')}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <datalist id="add-agent-models">
            {catalog.models.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <ModelCatalogStatus provider={provider} catalog={catalog} />

          <div className="add-agent-effective" aria-live="polite">
            <span>{t('modals.addAgent.effective')}</span>
            <b>{PROVIDER_THEME[provider].label}</b>
            <span>·</span>
            <b>{formatModelLabel(effectiveModel, { model, modelPreset })}</b>
          </div>
          {model.trim() && modelPreset && (
            <div className="add-agent-hint">
              {t('modals.addAgent.hint')}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <div className="spacer" />
          <button type="button" className="btn-secondary" disabled={submitting} onClick={close}>
            {t('modals.addAgent.cancel')}
          </button>
          <button type="button" className="btn-primary" disabled={submitting} onClick={() => void submit()}>
            {submitting ? t('modals.addAgent.starting') : t('modals.addAgent.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
