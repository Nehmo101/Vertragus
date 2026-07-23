import { memo } from 'react'
import type { AgentSlot } from '@shared/profile'
import type { AgentProviderId, DisabledModels, ProviderEnabled } from '@shared/providers'
import { MODEL_PRESETS, MODEL_PRESET_LABELS, formatModelLabel, modelAfterProviderChange, resolveModel } from '@shared/models'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import InfoTip from '@renderer/components/InfoTip'
import ModelCatalogStatus from '@renderer/components/ModelCatalogStatus'
import ModelCombo from '@renderer/components/ModelCombo'
import type { ModelCatalog } from '@renderer/modelCatalog'
import { HELP } from './help'
import { availableModels, parsePreset, presetAvailable, presetValue } from './modelSelection'
import { MultiAgentOverrideSelect, type MultiAgentOverrideChoice } from './MultiAgentOverrideSelect'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']

function parseCapabilityList(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}

interface AgentSlotRowProps {
  slot: AgentSlot
  index: number
  workspaceWorkingDir: string
  multiAgentGlobalEnabled: boolean
  providerEnabled: ProviderEnabled
  models: ModelCatalog
  disabledModels: DisabledModels
  onPatchSlot: (index: number, patch: Partial<AgentSlot>) => void
  onSetSlotMultiAgent: (index: number, choice: MultiAgentOverrideChoice) => void
  onRemoveSlot: (index: number) => void
}

/**
 * One subagent slot. Memoized so typing in one slot (or another section) does
 * not re-render the siblings — patchSlot keeps untouched slot references stable.
 */
const AgentSlotRow = memo(function AgentSlotRow({
  slot,
  index: idx,
  workspaceWorkingDir,
  multiAgentGlobalEnabled,
  providerEnabled,
  models,
  disabledModels,
  onPatchSlot,
  onSetSlotMultiAgent,
  onRemoveSlot
}: AgentSlotRowProps): JSX.Element {
  const slotModels = availableModels(models, disabledModels, slot.provider)
  return (
    <div className="slot-row">
      <div className="slot-role-field">
        <div className="slot-col-label">Rolle / Label <InfoTip text={HELP.role} /></div>
        <input
          className="slot-role-input"
          value={slot.role}
          placeholder={slot.provider}
          onChange={(e) => onPatchSlot(idx, { role: e.target.value })}
        />
      </div>
      <div className="slot-fields">
      <div style={{ flex: 1.1 }}>
        <div className="slot-col-label">
          Provider <InfoTip text={HELP.agentProvider} />
        </div>
        <select
          className="slot-select-sm"
          value={slot.provider}
          onChange={(e) => {
            const provider = e.target.value as AgentProviderId
            // Clear the explicit override only on a real provider
            // switch, so the preset resolves against the new provider.
            // A same-provider reselect keeps the saved model.
            onPatchSlot(idx, {
              provider,
              model: modelAfterProviderChange(slot.provider, provider, slot.model)
            })
          }}
        >
          {AGENT_PROVIDERS
            .filter((p) => providerEnabled[p] || p === slot.provider)
            .map((p) => (
            <option key={p} value={p}>
              {PROVIDER_THEME[p].label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ flex: 0.85 }}>
        <div className="slot-col-label">
          Preset <InfoTip text={HELP.modelPreset} />
        </div>
        <select
          className="slot-select-sm"
          value={presetValue(slot.modelPreset)}
          onChange={(e) => onPatchSlot(idx, { modelPreset: parsePreset(e.target.value) })}
        >
          <option value="">Legacy (CLI)</option>
          {MODEL_PRESETS.map((preset) => {
            const available = presetAvailable(models, slot.provider, preset)
            return (
              <option key={preset} value={preset} disabled={!available}>
                {MODEL_PRESET_LABELS[preset]}
                {!available ? ' (nicht verfügbar)' : ''}
              </option>
            )
          })}
        </select>
      </div>
      <div style={{ flex: 1.4 }}>
        <div className="slot-col-label">
          Modell <InfoTip text={HELP.model} />
          <span className="model-count" title="verfügbare Modelle dieses Providers (frei eingebbar)">
            {slotModels.length}
          </span>
        </div>
        <ModelCombo
          className="slot-select-sm mono"
          datalistId={`slot-models-${idx}`}
          models={slotModels}
          value={slot.model}
          onChange={(model) => onPatchSlot(idx, { model })}
        />
        <ModelCatalogStatus provider={slot.provider} catalog={models[slot.provider]} />
        <div className="model-effective" aria-live="polite">
          Effektiv: {formatModelLabel(resolveModel(slot.provider, slot), slot)}
        </div>
      </div>
      <div style={{ flex: 'none' }}>
        <div className="slot-col-label" style={{ textAlign: 'center' }}>
          Anzahl <InfoTip text={HELP.count} />
        </div>
        <div className="stepper">
          <button type="button" onClick={() => onPatchSlot(idx, { count: Math.max(1, slot.count - 1) })}>
            −
          </button>
          <span className="val">{slot.count}</span>
          <button type="button" onClick={() => onPatchSlot(idx, { count: slot.count + 1 })}>
            +
          </button>
        </div>
      </div>
      <div style={{ flex: 'none', textAlign: 'center' }}>
        <div className="slot-col-label">
          Yolo <InfoTip text={HELP.yolo} />
        </div>
        <button type="button"
          className={`slot-yolo ${slot.yolo ? 'on' : ''}`}
          onClick={() => onPatchSlot(idx, { yolo: !slot.yolo })}
        >
          <span className="knob" />
        </button>
      </div>
      <div style={{ flex: 'none', textAlign: 'center' }}>
        <div className="slot-col-label">steuerbar <InfoTip text={HELP.orchestrated} /></div>
        <button type="button"
          className={`ctrl-check ${slot.orchestrated ? 'on' : ''}`}
          onClick={() => onPatchSlot(idx, { orchestrated: !slot.orchestrated })}
        >
          {slot.orchestrated ? '✓' : ''}
        </button>
      </div>
      <button type="button"
        className="slot-remove"
        title="Slot entfernen"
        onClick={() => onRemoveSlot(idx)}
      >
        ✕
      </button>
      </div>
      <MultiAgentOverrideSelect
        id={`slot-multi-agent-${idx}`}
        value={slot.multiAgent}
        globalEnabled={multiAgentGlobalEnabled}
        onChange={(choice) => onSetSlotMultiAgent(idx, choice)}
      />
      <div className="slot-path-row">
        <div className="slot-path-field">
          <div className="slot-col-label">
            Eigener Pfad (optional) <InfoTip text={HELP.agentWorkingDir} />
          </div>
          <input
            className="slot-select-sm mono"
            placeholder={workspaceWorkingDir || 'Workspace-Basispfad'}
            value={slot.workingDir ?? ''}
            onChange={(event) =>
              onPatchSlot(idx, { workingDir: event.target.value || undefined })
            }
          />
        </div>
        <button
          type="button"
          className="btn-secondary slot-browse-btn"
          onClick={async () => {
            const dir = await window.vertragus.pickFolder()
            if (dir) onPatchSlot(idx, { workingDir: dir })
          }}
        >
          Durchsuchen…
        </button>
      </div>
      <div className="slot-path-row">
        <div className="slot-path-field">
          <div className="slot-col-label">
            Fallback-Modelle (optional) <InfoTip text={HELP.fallbackModels} />
          </div>
          <input
            className="slot-select-sm"
            placeholder="z. B. sonnet, haiku"
            value={(slot.fallbackModels ?? []).join(', ')}
            onChange={(event) =>
              onPatchSlot(idx, { fallbackModels: parseCapabilityList(event.target.value) })
            }
          />
        </div>
      </div>
      <div className="slot-path-row">
        <div className="slot-path-field">
          <div className="slot-col-label">
            Stärken (optional) <InfoTip text={HELP.strengths} />
          </div>
          <input
            className="slot-select-sm"
            placeholder="z. B. Frontend, Tests, Security-Review"
            value={slot.strengths.join(', ')}
            onChange={(event) =>
              onPatchSlot(idx, { strengths: parseCapabilityList(event.target.value) })
            }
          />
        </div>
        <div className="slot-path-field">
          <div className="slot-col-label">
            Schwächen (optional) <InfoTip text={HELP.weaknesses} />
          </div>
          <input
            className="slot-select-sm"
            placeholder="z. B. große Refactorings"
            value={slot.weaknesses.join(', ')}
            onChange={(event) =>
              onPatchSlot(idx, { weaknesses: parseCapabilityList(event.target.value) })
            }
          />
        </div>
      </div>
    </div>
  )
})

interface AgentSlotsSectionProps {
  agents: AgentSlot[]
  workspaceWorkingDir: string
  multiAgentGlobalEnabled: boolean
  providerEnabled: ProviderEnabled
  models: ModelCatalog
  disabledModels: DisabledModels
  onPatchSlot: (index: number, patch: Partial<AgentSlot>) => void
  onSetSlotMultiAgent: (index: number, choice: MultiAgentOverrideChoice) => void
  onRemoveSlot: (index: number) => void
  onAddSlot: () => void
}

/** Subagent-Slots: Liste aller Slot-Zeilen plus „Slot hinzufügen“. */
const AgentSlotsSection = memo(function AgentSlotsSection({
  agents,
  workspaceWorkingDir,
  multiAgentGlobalEnabled,
  providerEnabled,
  models,
  disabledModels,
  onPatchSlot,
  onSetSlotMultiAgent,
  onRemoveSlot,
  onAddSlot
}: AgentSlotsSectionProps): JSX.Element {
  const subTotal = agents.reduce((n, s) => n + s.count, 0)
  return (
    <>
      <div className="slots-caption">
        <span>Subagent-Slots</span>
        <span className="count">
          {agents.length} Slots · {subTotal} Agents
        </span>
      </div>

      <div className="slot-list">
        {agents.map((slot, idx) => (
          <AgentSlotRow
            key={idx}
            slot={slot}
            index={idx}
            workspaceWorkingDir={workspaceWorkingDir}
            multiAgentGlobalEnabled={multiAgentGlobalEnabled}
            providerEnabled={providerEnabled}
            models={models}
            disabledModels={disabledModels}
            onPatchSlot={onPatchSlot}
            onSetSlotMultiAgent={onSetSlotMultiAgent}
            onRemoveSlot={onRemoveSlot}
          />
        ))}
      </div>

      <button type="button" className="add-slot" onClick={() => onAddSlot()}>
        ＋ Slot hinzufügen
      </button>
    </>
  )
})

export default AgentSlotsSection
