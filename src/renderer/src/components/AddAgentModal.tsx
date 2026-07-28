import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModelCatalogStatus from '@renderer/components/ModelCatalogStatus'
import Modal from '@renderer/components/ui/Modal'
import Spinner from '@renderer/components/ui/Spinner'
import {
  modelPresetAvailability,
  type ProviderModelCatalog
} from '@renderer/modelCatalog'
import { useAppStore } from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import { effectiveModelLabel, presetLabel } from '@renderer/components/profileEditor/modelSelection'
import { MODEL_PRESETS, resolveModel, type ModelPreset } from '@shared/models'
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
    <Modal
      className="add-agent-modal"
      size="sm"
      labelledBy="add-agent-title"
      onClose={close}
      closeOnScrim={!submitting}
      closeOnEscape={!submitting}
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
                    {presetLabel(t, preset)}
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
            <b>{effectiveModelLabel(t, effectiveModel, { model, modelPreset })}</b>
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
            {submitting ? (
              <>
                <Spinner /> {t('modals.addAgent.starting')}
              </>
            ) : (
              t('modals.addAgent.start')
            )}
          </button>
        </div>
    </Modal>
  )
}
