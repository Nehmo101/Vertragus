import { useTranslation } from 'react-i18next'
import type { Profile } from '@shared/schema/profile'
import type { VertragusAppApi } from '../../../preload'
import { BroomIcon, ChartIcon, GearIcon, PlayIcon } from './icons'
import { RetroPanel } from './RetroPanel'
import { WorktreeCleanup } from './WorktreeCleanup'

interface Props {
  profile: Profile
  /** How many workspaces currently belong to this profile. */
  count: number
  /** Whether this profile is the active workspace filter. */
  selected: boolean
  onSelect(profileId: string): void
  onStart(profileId: string): void
  onEdit(profileId: string): void
  /** True while this row's worktree cleanup list is unfolded below it. */
  cleanupOpen: boolean
  onToggleCleanup(profileId: string): void
  /** True while this row's retro view is unfolded below it. */
  retroOpen: boolean
  onToggleRetro(profileId: string): void
  /** Bridge for the fold-out views; absent only when preload never loaded. */
  bridge?: VertragusAppApi
}

/**
 * One profile line: name + workspace count (toggles the filter), Play (opens
 * another workspace — pressing it twice gives two), chart (what the runs
 * taught the app, folded out below), broom (the worktree cleanup list, folded
 * out below), gear (profile editor). Play is deliberately the visually
 * loudest control in the panel; it is the one thing the app exists to do.
 * Name/count stay a sibling of the four buttons so filter clicks never hit
 * those targets.
 *
 * The row itself is a `div` inside an `li` wrapper: the fold-out views hang
 * as further children below the row, and they must not inherit the row's flex
 * layout or its selected/hover wash.
 */
export function ProfileRow({
  profile,
  count,
  selected,
  onSelect,
  onStart,
  onEdit,
  cleanupOpen,
  onToggleCleanup,
  retroOpen,
  onToggleRetro,
  bridge
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const start = t('panel.startWorkspace', { profile: profile.name })
  const edit = t('panel.editProfile', { profile: profile.name })
  const filter = t('panel.filterProfileWorkspaces', { profile: profile.name })
  const cleanup = t('panel.cleanupWorktrees', { profile: profile.name })
  const retro = t('panel.retroToggle', { profile: profile.name })
  return (
    <li className="panel-row-group">
      <div className={selected ? 'panel-row is-selected' : 'panel-row'}>
        <button
          type="button"
          className="panel-row-select"
          title={filter}
          aria-label={filter}
          aria-pressed={selected}
          onClick={() => onSelect(profile.id)}
        >
          <span className="panel-row-name" title={profile.repoPath || undefined}>
            {profile.name}
          </span>
          <span className="panel-row-count">{count}</span>
        </button>
        <button
          type="button"
          className="panel-play"
          title={start}
          aria-label={start}
          onClick={() => onStart(profile.id)}
        >
          <PlayIcon />
        </button>
        <button
          type="button"
          className={`panel-icon-button${retroOpen ? ' is-active' : ''}`}
          title={retro}
          aria-label={retro}
          aria-expanded={retroOpen}
          onClick={() => onToggleRetro(profile.id)}
        >
          <ChartIcon />
        </button>
        <button
          type="button"
          className={`panel-icon-button${cleanupOpen ? ' is-active' : ''}`}
          title={cleanup}
          aria-label={cleanup}
          aria-expanded={cleanupOpen}
          onClick={() => onToggleCleanup(profile.id)}
        >
          <BroomIcon />
        </button>
        <button
          type="button"
          className="panel-icon-button"
          title={edit}
          aria-label={edit}
          onClick={() => onEdit(profile.id)}
        >
          <GearIcon />
        </button>
      </div>
      {retroOpen && bridge ? (
        <RetroPanel key={profile.id} profileId={profile.id} bridge={bridge} />
      ) : null}
      {cleanupOpen && bridge ? (
        <WorktreeCleanup key={profile.id} profileId={profile.id} bridge={bridge} />
      ) : null}
    </li>
  )
}
