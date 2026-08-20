import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelLearning, RepoNote, RunRetro, VertragusAppApi } from '../../../preload'
import { errorText } from './viewModel'
import { groupLearnings, retroIsEmpty, runRows } from './retroViewModel'
import { TrashIcon } from './icons'

interface Props {
  profileId: string
  bridge: VertragusAppApi
}

/**
 * The retro list under a profile row: what the app learned about its models
 * (▲ strengths / ▼ weaknesses, each deletable) and how the last runs went.
 *
 * Same rules as WorktreeCleanup: errors stay inside this box, the caller keys
 * the component by profileId so switching profiles is a fresh mount, and the
 * only mutation is the explicit per-row delete.
 */
export function RetroPanel({ profileId, bridge }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [retros, setRetros] = useState<RunRetro[] | null>(null)
  const [learnings, setLearnings] = useState<ModelLearning[] | null>(null)
  const [repoNotes, setRepoNotes] = useState<RepoNote[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      bridge.listRetros(profileId),
      bridge.listLearnings(profileId),
      bridge.listRepoNotes(profileId)
    ]).then(
      ([nextRetros, nextLearnings, nextNotes]) => {
        if (!alive) return
        setRetros(nextRetros)
        setLearnings(nextLearnings)
        setRepoNotes(nextNotes)
      },
      (cause) => {
        if (alive) setError(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, profileId])

  const remove = (id: string): void => {
    setBusyId(id)
    setError(null)
    bridge.deleteLearning(id).then(
      (next) => {
        setBusyId(null)
        // The channel answers with the unfiltered list; keep the soft profile
        // filter the load applied: foreign profiles' learnings stay hidden.
        setLearnings(
          next.filter((entry) => !entry.profileId || entry.profileId === profileId)
        )
      },
      (cause) => {
        setBusyId(null)
        setError(errorText(cause))
      }
    )
  }

  const removeNote = (id: string): void => {
    setBusyId(id)
    setError(null)
    bridge.deleteRepoNote(id).then(
      (next) => {
        setBusyId(null)
        setRepoNotes(next.filter((entry) => entry.profileId === profileId))
      },
      (cause) => {
        setBusyId(null)
        setError(errorText(cause))
      }
    )
  }

  const groups = learnings ? groupLearnings(t, learnings) : []
  const runs = retros ? runRows(t, retros, i18n.language) : []

  return (
    <div className="panel-retro">
      {retros === null && learnings === null && !error ? (
        <p className="panel-retro-note">{t('panel.retroLoading')}</p>
      ) : null}
      {retroIsEmpty(retros, learnings) ? (
        <p className="panel-retro-note">{t('panel.retroEmpty')}</p>
      ) : null}

      {groups.length > 0 ? (
        <>
          <p className="panel-retro-label">{t('panel.retroLearnings')}</p>
          {groups.map((group) => (
            <div key={group.key} className="panel-retro-group">
              <p className="panel-retro-model">{group.label}</p>
              <ul className="panel-retro-list">
                {group.entries.map((entry) => (
                  <li key={entry.id} className="panel-retro-row" title={entry.title}>
                    <span
                      className={`panel-retro-marker${entry.marker === '▲' ? ' is-strength' : ' is-weakness'}`}
                    >
                      {entry.marker}
                    </span>
                    <span className="panel-retro-insight">{entry.insight}</span>
                    {entry.observationsLabel ? (
                      <span className="panel-retro-observations">{entry.observationsLabel}</span>
                    ) : null}
                    <button
                      type="button"
                      className="panel-icon-button panel-retro-remove"
                      title={t('panel.retroDeleteLearning', { insight: entry.insight })}
                      aria-label={t('panel.retroDeleteLearning', { insight: entry.insight })}
                      disabled={busyId !== null}
                      onClick={() => remove(entry.id)}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : null}

      {repoNotes && repoNotes.length > 0 ? (
        <>
          <p className="panel-retro-label">{t('panel.retroRepoNotes')}</p>
          <ul className="panel-retro-list">
            {repoNotes.map((note) => (
              <li key={note.id} className="panel-retro-row" title={note.note}>
                <span className="panel-retro-insight">{note.note}</span>
                <button
                  type="button"
                  className="panel-icon-button panel-retro-remove"
                  title={t('panel.retroDeleteRepoNote', { note: note.note })}
                  aria-label={t('panel.retroDeleteRepoNote', { note: note.note })}
                  disabled={busyId !== null}
                  onClick={() => removeNote(note.id)}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {runs.length > 0 ? (
        <>
          <p className="panel-retro-label">{t('panel.retroRuns')}</p>
          <ul className="panel-retro-list">
            {runs.map((run) => (
              <li key={run.id} className="panel-retro-row" title={run.title}>
                <span className="panel-retro-run-name">{run.name}</span>
                <span
                  className="panel-retro-tally"
                  aria-label={t('panel.retroRunTally', {
                    succeeded: run.succeeded,
                    blocked: run.blocked,
                    failed: run.failed
                  })}
                >
                  ✓{run.succeeded} ◐{run.blocked} ✗{run.failed}
                </span>
                <span className="panel-retro-date">{run.dateLabel}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {error ? <p className="panel-retro-error">{error}</p> : null}
    </div>
  )
}
