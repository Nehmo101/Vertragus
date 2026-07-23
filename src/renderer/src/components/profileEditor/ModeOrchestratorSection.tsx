import { memo, useEffect, useState } from 'react'
import type { OrchestratorConfig } from '@shared/profile'
import type { AgentProviderId, DisabledModels, ProviderEnabled } from '@shared/providers'
import {
  MODEL_PRESETS,
  MODEL_PRESET_LABELS,
  formatModelLabel,
  modelAfterProviderChange,
  resolveModel
} from '@shared/models'
import { recommendSoloModel } from '@shared/retro/soloModel'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import InfoTip from '@renderer/components/InfoTip'
import ModelCatalogStatus from '@renderer/components/ModelCatalogStatus'
import ClaudePermissionModeSelect from '@renderer/components/ClaudePermissionModeSelect'
import ModelCombo from '@renderer/components/ModelCombo'
import type { ModelCatalog } from '@renderer/modelCatalog'
import { HELP } from './help'
import { availableModels, parsePreset, presetAvailable, presetValue } from './modelSelection'
import type { ProfileEditorMode } from './draftReducer'

const ORCHESTRATOR_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'copilot']

/**
 * Benchmark/retro-driven model suggestion for the Efficiency-Solo mode.
 * Pure hint — the user always keeps the final model choice.
 */
function SoloModelHint({ provider }: { provider?: AgentProviderId }): JSX.Element | null {
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
              ? `Empfohlen laut Benchmarks/Retros: ${best.provider}${best.model ? ` · ${best.model}` : ' (CLI-Standard)'} — ${best.rationale}`
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
  }, [provider])
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

/** Modus-Umschalter (Orchestriert/Single/Efficiency Solo) plus Orchestrator-Konfiguration. */
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
  const orchestratorModels = orchestrator
    ? availableModels(models, disabledModels, orchestrator.provider)
    : []

  return (
    <>
      <div className="field-label" style={{ marginBottom: 8 }}>
        Modus <InfoTip text={HELP.mode} />
      </div>
      <div className="mode-toggle">
        <button type="button"
          className={orchestrator ? 'active' : ''}
          onClick={() => onSetMode('orchestrated')}
        >
          🪄 Orchestriert
          <span>ein Orchestrator delegiert an Subagents</span>
        </button>
        <button type="button"
          className={!orchestrator && !solo ? 'active' : ''}
          onClick={() => onSetMode('single')}
        >
          ⚡ Single
          <span>alle Slots laufen parallel, kein Orchestrator</span>
        </button>
        <button type="button"
          className={!orchestrator && solo ? 'active' : ''}
          onClick={() => onSetMode('solo')}
        >
          🎯 Efficiency Solo
          <span>ein Agent arbeitet direkt, minimaler Tokenverbrauch</span>
        </button>
      </div>
      {!orchestrator && solo && <SoloModelHint provider={soloProvider} />}
      {orchestrator ? (
        <div className="orch-block">
          <span className="avatar">◇</span>
          <div style={{ flex: 1 }}>
            <div className="select-label">
              Provider <InfoTip text={HELP.orchestratorProvider} />
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
            <div style={{ flex: 1.4 }}>
              <div className="select-label">
                Claude-Modus <InfoTip text={HELP.permissionMode} />
              </div>
              <ClaudePermissionModeSelect
                id="orchestrator-permission-mode"
                value={orchestrator.permissionMode ?? 'default'}
                onChange={(permissionMode) => onPatchOrchestrator({ permissionMode })}
              />
            </div>
          )}
          <div style={{ flex: 0.9 }}>
            <div className="select-label">
              Preset <InfoTip text={HELP.modelPreset} />
            </div>
            <select
              className="select"
              value={presetValue(orchestrator.modelPreset)}
              onChange={(e) => onPatchOrchestrator({ modelPreset: parsePreset(e.target.value) })}
            >
              <option value="">Legacy (CLI)</option>
              {MODEL_PRESETS.map((preset) => {
                const available = presetAvailable(models, orchestrator.provider, preset)
                return (
                  <option key={preset} value={preset} disabled={!available}>
                    {MODEL_PRESET_LABELS[preset]}
                    {!available ? ' (nicht verfügbar)' : ''}
                  </option>
                )
              })}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div className="select-label">
              Modell <InfoTip text={HELP.model} />
              <span className="model-count" title="verfügbare Modelle dieses Providers (frei eingebbar)">
                {orchestratorModels.length}
              </span>
            </div>
            <ModelCombo
              className="select mono"
              datalistId="orch-models"
              models={orchestratorModels}
              value={orchestrator.model}
              onChange={(model) => onPatchOrchestrator({ model })}
            />
            <ModelCatalogStatus
              provider={orchestrator.provider}
              catalog={models[orchestrator.provider]}
            />
            <div className="model-effective" aria-live="polite">
              Effektiv:{' '}
              {formatModelLabel(
                resolveModel(orchestrator.provider, orchestrator),
                orchestrator
              )}
            </div>
          </div>
          <div className="orch-note">steuert Subagents</div>
        </div>
      ) : (
        <div className="single-hint">
          Kein Orchestrator — beim Start laufen alle Subagent-Slots (mit ihrer Anzahl) parallel
          als eigenständige, interaktive Agents.
        </div>
      )}
    </>
  )
})

export default ModeOrchestratorSection
