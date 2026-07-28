import { memo } from 'react'
import { useTranslation } from 'react-i18next'
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

/** Auto subagent planner including auto benchmark and the global multi-agent mode. */
const PlannerSection = memo(function PlannerSection({
  planner,
  benchmarkEnabled,
  multiAgentEnabled,
  hasOrchestrator,
  onPatchPlanner,
  onSetBenchmarkEnabled,
  onSetMultiAgentEnabled
}: PlannerSectionProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="automation-section" aria-labelledby="planner-heading">
      <div className="slots-caption compact-caption">
        <span id="planner-heading">{t('profile.planner.heading')}</span>
        <span className="count">{t('profile.planner.headingSub')}</span>
      </div>
      <div className="automation-grid">
        <label>
          <span className="slot-col-label">
            {t('profile.planner.teamStart')} <InfoTip text={t(HELP.routingMode)} />
          </span>
          <select
            className="slot-select-sm"
            value={planner.routingMode}
            onChange={(event) =>
              onPatchPlanner({ routingMode: event.target.value as PlannerConfig['routingMode'] })
            }
          >
            <option value="adaptive">{t('profile.planner.routingAdaptive')}</option>
            <option value="fixed">{t('profile.planner.routingFixed')}</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            {t('profile.planner.plannerMode')} <InfoTip text={t(HELP.plannerMode)} />
          </span>
          <select
            className="slot-select-sm"
            value={planner.mode}
            onChange={(event) =>
              onPatchPlanner({ mode: event.target.value as PlannerConfig['mode'] })
            }
          >
            <option value="auto">{t('profile.planner.modeAuto')}</option>
            <option value="review">{t('profile.planner.modeReview')}</option>
            <option value="manual">{t('profile.planner.modeManual')}</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            {t('profile.planner.maxParallel')} <InfoTip text={t(HELP.maxParallel)} />
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
            {t('profile.planner.maxRetries')} <InfoTip text={t(HELP.maxRetries)} />
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
            {t('profile.planner.benchmark')} <InfoTip text={t(HELP.benchmark)} />
          </span>
          <select
            className="slot-select-sm"
            value={benchmarkEnabled ? 'on' : 'off'}
            disabled={!hasOrchestrator}
            title={!hasOrchestrator ? t('profile.planner.benchmarkNeedsOrch') : undefined}
            onChange={(event) => onSetBenchmarkEnabled(event.target.value === 'on')}
          >
            <option value="off">{t('profile.planner.off')}</option>
            <option value="on">{t('profile.planner.benchmarkOn')}</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            {t('profile.planner.multiAgent')} <InfoTip text={t(HELP.multiAgent)} />
          </span>
          <select
            className="slot-select-sm"
            value={multiAgentEnabled ? 'on' : 'off'}
            disabled={!hasOrchestrator}
            title={!hasOrchestrator ? t('profile.planner.multiAgentNeedsOrch') : undefined}
            onChange={(event) => onSetMultiAgentEnabled(event.target.value === 'on')}
          >
            <option value="off">{t('profile.planner.multiOff')}</option>
            <option value="on">{t('profile.planner.multiOn')}</option>
          </select>
        </label>
      </div>
    </section>
  )
})

export default PlannerSection
