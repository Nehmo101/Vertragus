import { memo } from 'react'
import type { AutoGitConfig } from '@shared/profile'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './help'

interface AutoGitSectionProps {
  autoGit: AutoGitConfig
  /** Validation message for the target branch; undefined = valid. */
  branchError?: string
  onPatchAutoGit: (patch: Partial<AutoGitConfig>) => void
}

/** Auto-Commit & Push nach vollständig erfolgreichem Lauf. */
const AutoGitSection = memo(function AutoGitSection({
  autoGit,
  branchError,
  onPatchAutoGit
}: AutoGitSectionProps): JSX.Element {
  return (
    <section className="automation-section" aria-labelledby="auto-git-heading">
      <div className="slots-caption compact-caption">
        <span id="auto-git-heading">Auto-Commit &amp; Push</span>
        <span className="count">nur nach vollständig erfolgreichem Lauf</span>
      </div>
      <div className="automation-grid auto-git-grid">
        <label>
          <span className="slot-col-label">
            Modus <InfoTip text={HELP.autoGitMode} />
          </span>
          <select
            className="slot-select-sm"
            value={autoGit.enabled ? 'on' : 'off'}
            onChange={(event) => onPatchAutoGit({ enabled: event.target.value === 'on' })}
          >
            <option value="off">Aus</option>
            <option value="on">Nach Erfolg committen &amp; pushen</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            Ziel-Branch <InfoTip text={HELP.autoGitBranch} />
          </span>
          <input
            className={`slot-select-sm mono ${branchError ? 'input-invalid' : ''}`}
            placeholder="z. B. vertragus/integrated"
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
