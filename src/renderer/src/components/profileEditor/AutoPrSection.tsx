import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutoPrConfig } from '@shared/profile'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './help'

interface AutoPrSectionProps {
  autoPr: AutoPrConfig
  /** Default branch of the bound GitHub repo (placeholder only). */
  boundDefaultBranch?: string
  onPatchAutoPr: (patch: Partial<AutoPrConfig>) => void
}

/** Auto PR: mode, strategy, base branch and quality gates. */
const AutoPrSection = memo(function AutoPrSection({
  autoPr,
  boundDefaultBranch,
  onPatchAutoPr
}: AutoPrSectionProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="automation-section" aria-labelledby="auto-pr-heading">
      <div className="slots-caption compact-caption">
        <span id="auto-pr-heading">{t('profile.autoPr.heading')}</span>
        <span className="count">{t('profile.autoPr.headingSub')}</span>
      </div>
      <div className="automation-grid auto-pr-grid">
        <label>
          <span className="slot-col-label">
            {t('profile.autoPr.mode')} <InfoTip text={t(HELP.autoPrMode)} />
          </span>
          <select
            className="slot-select-sm"
            value={autoPr.mode}
            onChange={(event) =>
              onPatchAutoPr({ mode: event.target.value as AutoPrConfig['mode'] })
            }
          >
            <option value="off">{t('profile.autoPr.off')}</option>
            <option value="draft-after-checks">{t('profile.autoPr.draftAfterChecks')}</option>
            <option value="ready-after-checks">{t('profile.autoPr.readyAfterChecks')}</option>
            <option value="hold-for-approval">{t('profile.autoPr.holdForApproval')}</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            {t('profile.autoPr.strategy')} <InfoTip text={t(HELP.prStrategy)} />
          </span>
          <select
            className="slot-select-sm"
            value={autoPr.strategy}
            onChange={(event) =>
              onPatchAutoPr({ strategy: event.target.value as AutoPrConfig['strategy'] })
            }
          >
            <option value="aggregate">{t('profile.autoPr.aggregate')}</option>
            <option value="per-task">{t('profile.autoPr.perTask')}</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            {t('profile.autoPr.baseBranch')} <InfoTip text={t(HELP.baseBranch)} />
          </span>
          <input
            className="slot-select-sm mono"
            placeholder={
              boundDefaultBranch ||
              autoPr.baseBranch ||
              t('profile.autoPr.boundDefault')
            }
            value={autoPr.baseBranch}
            onChange={(event) => onPatchAutoPr({ baseBranch: event.target.value })}
          />
        </label>
        <label className="quality-gates-field">
          <span className="slot-col-label">
            {t('profile.autoPr.qualityGates')} <InfoTip text={t(HELP.qualityGates)} />
          </span>
          <textarea
            className="text-input mono quality-gates"
            value={autoPr.qualityGates.join('\n')}
            onChange={(event) =>
              onPatchAutoPr({
                qualityGates: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
              })
            }
          />
        </label>
      </div>
    </section>
  )
})

export default AutoPrSection
