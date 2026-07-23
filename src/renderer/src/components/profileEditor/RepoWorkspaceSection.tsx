import { memo } from 'react'
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

/** Working Directory plus KI-Profilgenerierung und Retro-Erkenntnisse. */
const RepoWorkspaceSection = memo(function RepoWorkspaceSection({
  workingDir,
  repoLocalPath,
  generating,
  generateElapsed,
  generateStatus,
  learningsStatus,
  onPatchProfile,
  onGenerateFromRepo,
  onApplyLearnings
}: RepoWorkspaceSectionProps): JSX.Element {
  return (
    <>
      <label className="field-label" htmlFor="profile-working-dir">
        Working Directory (Repo) <InfoTip text={HELP.workingDir} />
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
          Durchsuchen…
        </button>
      </div>
      <button
        type="button"
        className="btn-secondary profile-generate-btn"
        disabled={generating || !repoLocalPath}
        title={HELP.generateFromRepo}
        onClick={() => onGenerateFromRepo()}
      >
        {generating
          ? `Repo wird analysiert… ${formatElapsed(generateElapsed)}`
          : 'KI-Profil aus Git-Repo erzeugen'}
      </button>
      <button
        type="button"
        className="btn-secondary profile-generate-btn"
        title={HELP.applyLearnings}
        onClick={() => onApplyLearnings()}
      >
        Retro-Erkenntnisse übernehmen
      </button>
      {generating && (
        <div className="profile-generate-progress" aria-live="polite">
          <span className="profile-generate-spinner" aria-hidden="true" />
          Das ausgewählte Modell liest das Repository read-only und entwirft ein Profil. Je
          nach Repo-Größe dauert das ein bis mehrere Minuten — das Fenster kann offen bleiben.
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
