import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutoGitConfig } from '@shared/profile'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './help'

interface AutoGitSectionProps {
  autoGit: AutoGitConfig
  /** Validation message for the target branch; undefined = valid. */
  branchError?: string
  onPatchAutoGit: (patch: Partial<AutoGitConfig>) => void
}

/** Auto commit & push after a fully successful run. */
const AutoGitSection = memo(function AutoGitSection({
  autoGit,
  branchError,
  onPatchAutoGit
}: AutoGitSectionProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="automation-section" aria-labelledby="auto-git-heading">
      <div className="slots-caption compact-caption">
        <span id="auto-git-heading">{t('profile.autoGit.heading')}</span>
        <span className="count">{t('profile.autoGit.headingSub')}</span>
      </div>
      <div className="automation-grid auto-git-grid">
        <label>
          <span className="slot-col-label">
            {t('profile.autoGit.mode')} <InfoTip text={t(HELP.autoGitMode)} />
          </span>
          <select
            className="slot-select-sm"
            value={autoGit.enabled ? 'on' : 'off'}
            onChange={(event) => onPatchAutoGit({ enabled: event.target.value === 'on' })}
          >
            <option value="off">{t('profile.autoGit.off')}</option>
            <option value="on">{t('profile.autoGit.on')}</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            {t('profile.autoGit.targetBranch')} <InfoTip text={t(HELP.autoGitBranch)} />
          </span>
          <input
            className={`slot-select-sm mono ${branchError ? 'input-invalid' : ''}`}
            placeholder={t('profile.autoGit.branchPlaceholder')}
            value={autoGit.targetBranch}
            aria-invalid={Boolean(branchError)}
            aria-describedby={branchError ? 'auto-git-branch-error' : undefined}
            onChange={(event) => onPatchAutoGit({ targetBranch: event.target.value })}
          />
        </label>
      </div>
      {branchError && (
        <div id="auto-git-branch-error" className="automation-validation-error" role="alert">
          {branchError}
        </div>
      )}
    </section>
  )
})

export default AutoGitSection
