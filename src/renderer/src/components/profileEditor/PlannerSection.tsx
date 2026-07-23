import { memo } from 'react'
import type { PlannerConfig } from '@shared/profile'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './help'

function boundedNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

interface PlannerSectionProps {
  planner: PlannerConfig
  benchmarkEnabled: boolean
  multiAgentEnabled: boolean
  hasOrchestrator: boolean
  onPatchPlanner: (patch: Partial<PlannerConfig>) => void
  onSetBenchmarkEnabled: (enabled: boolean) => void
  onSetMultiAgentEnabled: (enabled: boolean) => void
}

/** Auto-Subagent-Planer inklusive Auto-Benchmark und globalem Multiagent-Modus. */
const PlannerSection = memo(function PlannerSection({
  planner,
  benchmarkEnabled,
  multiAgentEnabled,
  hasOrchestrator,
  onPatchPlanner,
  onSetBenchmarkEnabled,
  onSetMultiAgentEnabled
}: PlannerSectionProps): JSX.Element {
  return (
    <section className="automation-section" aria-labelledby="planner-heading">
      <div className="slots-caption compact-caption">
        <span id="planner-heading">Auto-Subagent-Planer</span>
        <span className="count">entscheidet Parallelität und Re-Planning</span>
      </div>
      <div className="automation-grid">
        <label>
          <span className="slot-col-label">
            Team-Start <InfoTip text={HELP.routingMode} />
          </span>
          <select
            className="slot-select-sm"
            value={planner.routingMode}
            onChange={(event) =>
              onPatchPlanner({ routingMode: event.target.value as PlannerConfig['routingMode'] })
            }
          >
            <option value="adaptive">Adaptiv — nach Plan aktivieren</option>
            <option value="fixed">Vorgewärmt — alle Slots starten</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            Planungsmodus <InfoTip text={HELP.plannerMode} />
          </span>
          <select
            className="slot-select-sm"
            value={planner.mode}
            onChange={(event) =>
              onPatchPlanner({ mode: event.target.value as PlannerConfig['mode'] })
            }
          >
            <option value="auto">Auto — direkt ausführen</option>
            <option value="review">Review — Plan bestätigen</option>
            <option value="manual">Manuell — keine Auto-Planung</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            Max. parallel <InfoTip text={HELP.maxParallel} />
          </span>
          <input
            className="slot-select-sm"
            type="number"
            min={1}
            max={32}
            value={planner.maxParallel}
            onChange={(event) => onPatchPlanner({ maxParallel: boundedNumber(event.currentTarget.valueAsNumber, 1, 32, planner.maxParallel) })}
          />
        </label>
        <label>
          <span className="slot-col-label">
            Re-Plan-Versuche <InfoTip text={HELP.maxRetries} />
          </span>
          <input
            className="slot-select-sm"
            type="number"
            min={0}
            max={5}
            value={planner.maxRetries}
            onChange={(event) => onPatchPlanner({
              maxRetries: boundedNumber(event.currentTarget.valueAsNumber, 0, 5, planner.maxRetries)
            })}
          />
        </label>
        <label>
          <span className="slot-col-label">
            Auto-Benchmark <InfoTip text={HELP.benchmark} />
          </span>
          <select
            className="slot-select-sm"
            value={benchmarkEnabled ? 'on' : 'off'}
            disabled={!hasOrchestrator}
            title={!hasOrchestrator ? 'Auto-Benchmark benötigt einen Orchestrator.' : undefined}
            onChange={(event) => onSetBenchmarkEnabled(event.target.value === 'on')}
          >
            <option value="off">Aus</option>
            <option value="on">Aktiv — gleiche Aufgabe für alle Slots</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            Multiagent-Modus <InfoTip text={HELP.multiAgent} />
          </span>
          <select
            className="slot-select-sm"
            value={multiAgentEnabled ? 'on' : 'off'}
            disabled={!hasOrchestrator}
            title={!hasOrchestrator ? 'Multiagent-Modus benötigt einen Orchestrator.' : undefined}
            onChange={(event) => onSetMultiAgentEnabled(event.target.value === 'on')}
          >
            <option value="off">Aus — ein Agent je Task</option>
            <option value="on">Aktiv — Slot-Anzahl als Kandidaten</option>
          </select>
        </label>
      </div>
    </section>
  )
})

export default PlannerSection
