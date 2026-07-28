import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrchestratorConfig } from '@shared/profile'
import type { AgentProviderId, DisabledModels, ProviderEnabled } from '@shared/providers'
import { MODEL_PRESETS, modelAfterProviderChange, resolveModel } from '@shared/models'
import { recommendSoloModel } from '@shared/retro/soloModel'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import InfoTip from '@renderer/components/InfoTip'
import ModelCatalogStatus from '@renderer/components/ModelCatalogStatus'
import ClaudePermissionModeSelect from '@renderer/components/ClaudePermissionModeSelect'
import ModelCombo from '@renderer/components/ModelCombo'
import type { ModelCatalog } from '@renderer/modelCatalog'
import { HELP } from './help'
import {
  availableModels,
  effectiveModelLabel,
  parsePreset,
  presetAvailable,
  presetOptionLabel,
  presetValue
} from './modelSelection'
import type { ProfileEditorMode } from './draftReducer'

const ORCHESTRATOR_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'copilot']

/**
 * Benchmark/retro-driven model suggestion for the Efficiency-Solo mode.
 * Pure hint — the user always keeps the final model choice.
 */
function SoloModelHint({ provider }: { provider?: AgentProviderId }): JSX.Element | null {
  const { t } = useTranslation()
  const [hint, setHint] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [learnings, benchmarks] = await Promise.all([
          window.vertragus.retro.listLearnings(),
          window.vertragus.retro.listBenchmarks()
        ])
        const [best] = recommendSoloModel(learnings, benchmarks, provider)
        if (!cancelled) {
          setHint(
            best
              ? t('profile.mode.soloHint', {
                  model: `${best.provider}${best.model ? ` · ${best.model}` : ` (${t('profile.cliDefault')})`}`,
                  rationale: best.rationale
                })
              : null
          )
        }
      } catch {
        if (!cancelled) setHint(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [provider, t])
  if (!hint) return null
  return (
    <div className="model-effective" aria-live="polite" style={{ marginBottom: 8 }}>
      {hint}
    </div>
  )
}

interface ModeOrchestratorSectionProps {
  orchestrator?: OrchestratorConfig
  solo: boolean
  /** Provider of the first slot — drives the solo model hint. */
  soloProvider?: AgentProviderId
  providerEnabled: ProviderEnabled
  models: ModelCatalog
  disabledModels: DisabledModels
  onSetMode: (mode: ProfileEditorMode) => void
  onPatchOrchestrator: (patch: Partial<OrchestratorConfig>) => void
}

/** Mode switch (orchestrated/single/efficiency solo) plus orchestrator configuration. */
const ModeOrchestratorSection = memo(function ModeOrchestratorSection({
  orchestrator,
  solo,
  soloProvider,
  providerEnabled,
  models,
  disabledModels,
  onSetMode,
  onPatchOrchestrator
}: ModeOrchestratorSectionProps): JSX.Element {
  const { t } = useTranslation()
  const orchestratorModels = orchestrator
    ? availableModels(models, disabledModels, orchestrator.provider)
    : []

  return (
    <>
      <div className="field-label" style={{ marginBottom: 8 }}>
        {t('profile.mode.label')} <InfoTip text={t(HELP.mode)} />
      </div>
      <div className="mode-toggle">
        <button type="button"
          className={orchestrator ? 'active' : ''}
          onClick={() => onSetMode('orchestrated')}
        >
          🪄 {t('profile.mode.orchestrated')}
          <span>{t('profile.mode.orchestratedSub')}</span>
        </button>
        <button type="button"
          className={!orchestrator && !solo ? 'active' : ''}
          onClick={() => onSetMode('single')}
        >
          ⚡ {t('profile.mode.single')}
          <span>{t('profile.mode.singleSub')}</span>
        </button>
        <button type="button"
          className={!orchestrator && solo ? 'active' : ''}
          onClick={() => onSetMode('solo')}
        >
          🎯 {t('profile.mode.solo')}
          <span>{t('profile.mode.soloSub')}</span>
        </button>
      </div>
      {!orchestrator && solo && <SoloModelHint provider={soloProvider} />}
      {orchestrator ? (
        <div className="orch-block">
          <span className="avatar">◇</span>
          <div className="orch-field">
            <div className="select-label">
              {t('profile.mode.provider')} <InfoTip text={t(HELP.orchestratorProvider)} />
            </div>
            <select
              className="select"
              value={orchestrator.provider}
              onChange={(e) => {
                const provider = e.target.value as AgentProviderId
                // An explicit model takes priority over a preset.
                // Clear it only on a real provider switch so a stale,
                // incompatible id never carries over — a same-provider
                // reselect must keep the saved model.
                onPatchOrchestrator({
                  provider,
                  model: modelAfterProviderChange(
                    orchestrator.provider,
                    provider,
                    orchestrator.model
                  )
                })
              }}
            >
              {ORCHESTRATOR_PROVIDERS
                .filter((p) => providerEnabled[p] || p === orchestrator.provider)
                .map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_THEME[p].label}
                </option>
              ))}
            </select>
          </div>
          {orchestrator.provider === 'claude' && (
            <div className="orch-field wide">
              <div className="select-label">
                {t('profile.mode.claudeMode')} <InfoTip text={t(HELP.permissionMode)} />
              </div>
              <ClaudePermissionModeSelect
                id="orchestrator-permission-mode"
                value={orchestrator.permissionMode ?? 'default'}
                onChange={(permissionMode) => onPatchOrchestrator({ permissionMode })}
              />
            </div>
          )}
          <div className="orch-field">
            <div className="select-label">
              {t('profile.mode.preset')} <InfoTip text={t(HELP.modelPreset)} />
            </div>
            <select
              className="select"
              value={presetValue(orchestrator.modelPreset)}
              onChange={(e) => onPatchOrchestrator({ modelPreset: parsePreset(e.target.value) })}
            >
              <option value="">{t('profile.mode.presetNone')}</option>
              {MODEL_PRESETS.map((preset) => {
                const available = presetAvailable(models, orchestrator.provider, preset)
                return (
                  <option key={preset} value={preset} disabled={!available}>
                    {presetOptionLabel(t, orchestrator.provider, preset)}
                    {!available ? t('profile.mode.presetUnavailable') : ''}
                  </option>
                )
              })}
            </select>
          </div>
          <div className="orch-model-field">
            <div className="select-label">
              {t('profile.mode.model')} <InfoTip text={t(HELP.model)} />
              <span className="model-count" title={t('profile.mode.modelCountTitle')}>
                {orchestratorModels.length}
              </span>
            </div>
            <ModelCombo
              className="select mono"
              id="orch-models"
              models={orchestratorModels}
              value={orchestrator.model}
              onChange={(model) => onPatchOrchestrator({ model })}
            />
            <ModelCatalogStatus
              provider={orchestrator.provider}
              catalog={models[orchestrator.provider]}
            />
            <div className="model-effective" aria-live="polite">
              {t('profile.mode.effective')}{' '}
              {effectiveModelLabel(
                t,
                resolveModel(orchestrator.provider, orchestrator),
                orchestrator
              )}
            </div>
          </div>
          <div className="orch-note">{t('profile.mode.controlsSubagents')}</div>
        </div>
      ) : (
        <div className="single-hint">{t('profile.mode.singleHint')}</div>
      )}
    </>
  )
})

export default ModeOrchestratorSection
