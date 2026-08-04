import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceProfile } from '@shared/profile'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './help'

/** "m:ss" elapsed label for the long-running repo analysis. */
function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

interface RepoWorkspaceSectionProps {
  workingDir: string
  /** Trusted warm-up commands run once per fresh worktree after the install. */
  setupCommands: string[]
  /** Effective repo path (githubRepo.localPath or workingDir); empty disables generation. */
  repoLocalPath: string
  generating: boolean
  generateElapsed: number
  generateStatus: string
  learningsStatus: string
  onPatchProfile: (patch: Partial<WorkspaceProfile>) => void
  onGenerateFromRepo: () => void
  onApplyLearnings: () => void
}

/** Working directory plus AI profile generation and retro findings. */
const RepoWorkspaceSection = memo(function RepoWorkspaceSection({
  workingDir,
  setupCommands,
  repoLocalPath,
  generating,
  generateElapsed,
  generateStatus,
  learningsStatus,
  onPatchProfile,
  onGenerateFromRepo,
  onApplyLearnings
}: RepoWorkspaceSectionProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <label className="field-label" htmlFor="profile-working-dir">
        {t('profile.repo.workingDir')} <InfoTip text={t(HELP.workingDir)} />
      </label>
      <div className="dir-row">
        <input
          id="profile-working-dir"
          className="text-input mono"
          placeholder="C:\git\mein-repo"
          value={workingDir}
          onChange={(e) => onPatchProfile({ workingDir: e.target.value })}
        />
        <button type="button"
          className="btn-secondary browse-btn"
          onClick={async () => {
            const dir = await window.vertragus.pickFolder()
            if (dir) onPatchProfile({ workingDir: dir })
          }}
        >
          {t('profile.repo.browse')}
        </button>
      </div>
      <label className="field-label" htmlFor="profile-setup-commands">
        {t('profile.repo.setupCommands')} <InfoTip text={t(HELP.setupCommands)} />
      </label>
      <textarea
        id="profile-setup-commands"
        className="text-input mono quality-gates"
        placeholder={t('profile.repo.setupCommandsPlaceholder')}
        value={setupCommands.join('\n')}
        onChange={(e) =>
          onPatchProfile({
            setupCommands: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
          })
        }
      />
      <button
        type="button"
        className="btn-secondary profile-generate-btn"
        disabled={generating || !repoLocalPath}
        title={t(HELP.generateFromRepo)}
        onClick={() => onGenerateFromRepo()}
      >
        {generating
          ? t('profile.repo.analyzing', { elapsed: formatElapsed(generateElapsed) })
          : t('profile.repo.generate')}
      </button>
      <button
        type="button"
        className="btn-secondary profile-generate-btn"
        title={t(HELP.applyLearnings)}
        onClick={() => onApplyLearnings()}
      >
        {t('profile.repo.applyLearnings')}
      </button>
      {generating && (
        <div className="profile-generate-progress" aria-live="polite">
          <span className="profile-generate-spinner" aria-hidden="true" />
          {t('profile.repo.generatingHint')}
        </div>
      )}
      {(generateStatus || learningsStatus) && (
        <div className="github-project-status" aria-live="polite">
          {generateStatus || learningsStatus}
        </div>
      )}
    </>
  )
})

export default RepoWorkspaceSection
