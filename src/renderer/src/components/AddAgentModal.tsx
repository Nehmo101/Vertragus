import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModelCatalogStatus from '@renderer/components/ModelCatalogStatus'
import ModelCombo from '@renderer/components/ModelCombo'
import Modal from '@renderer/components/ui/Modal'
import Spinner from '@renderer/components/ui/Spinner'
import { useAppStore } from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import {
  effectiveModelLabel,
  effortNote,
  effortOptionLabel,
  effortOptions,
  effortTerm,
  parseEffort,
  providerSupportsEffort
} from '@renderer/components/profileEditor/modelSelection'
import { resolveModel } from '@shared/models'
import type { EffortLevel } from '@shared/effort'
import type { AgentProviderId } from '@shared/providers'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']

export default function AddAgentModal(): JSX.Element | null {
  const { t } = useTranslation()
  const open = useAppStore((state) => state.addAgentOpen)
  const models = useAppStore((state) => state.models)
  const close = useAppStore((state) => state.closeAddAgent)
  const addAgent = useAppStore((state) => state.addAgent)
  const [provider, setProvider] = useState<AgentProviderId>('codex')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<EffortLevel | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)

  const catalog = models[provider]
  const effectiveModel = useMemo(() => resolveModel(provider, { model }), [model, provider])

  if (!open) return null

  const submit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      await addAgent({ provider, model: model.trim(), effort })
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
                // Effort rungs are provider-specific; keep only a supported one.
                setEffort((current) =>
                  current && effortOptions(next).includes(current) ? current : undefined
                )
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
            <span className="field-label">
              {t('modals.addAgent.effort', { term: effortTerm(provider) })}
            </span>
            <select
              className="slot-select-sm"
              value={effort ?? ''}
              disabled={!providerSupportsEffort(provider)}
              onChange={(event) => setEffort(parseEffort(event.target.value))}
            >
              <option value="">{t('modals.addAgent.cliDefault')}</option>
              {effortOptions(provider).map((level) => (
                <option key={level} value={level}>
                  {effortOptionLabel(t, provider, level)}
                </option>
              ))}
            </select>
            {!providerSupportsEffort(provider) && (
              <span className="add-agent-hint">{effortNote(provider)}</span>
            )}
          </label>

          <label>
            <span className="field-label">{t('modals.addAgent.model')}</span>
            <ModelCombo
              className="slot-select-sm mono"
              id="add-agent-models"
              models={catalog.models}
              value={model}
              onChange={setModel}
            />
          </label>
          <ModelCatalogStatus provider={provider} catalog={catalog} />

          <div className="add-agent-effective" aria-live="polite">
            <span>{t('modals.addAgent.effective')}</span>
            <b>{PROVIDER_THEME[provider].label}</b>
            <span>·</span>
            <b>{effectiveModelLabel(t, effectiveModel)}</b>
          </div>
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
