import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GithubAuthStatus, GitInfo, GitWorktreeInfo } from '@shared/ipc'
import { githubAuthPresentation, hasUsableGithubAuth } from '@renderer/store/githubAuth'
import {
  buildGitBranchTree,
  compactWorktreePath,
  gitWorkspaceTreeGate,
  type GitWorkspaceTreeGate
} from '@renderer/gitWorkspaceTree'

interface Props {
  /** True once a repository (profile default or switcher override) is selected. */
  repoBound: boolean
  /** Label of the active repository shown in the popover header. */
  repoLabel: string
  gitInfo: GitInfo | null
  githubAuth: GithubAuthStatus | null
}

function emptyState(
  gate: Exclude<GitWorkspaceTreeGate, 'ready'>,
  auth: GithubAuthStatus | null
): JSX.Element {
  const presentation = githubAuthPresentation(auth)
  const copy = {
    'checking-auth': {
      icon: '…',
      title: 'GitHub-Status wird geprüft',
      detail: 'Der Branch-Baum erscheint, sobald der Verbindungsstatus feststeht.'
    },
    'needs-auth': {
      icon: '◇',
      title: auth?.needsReauth ? 'GitHub-Berechtigungen erneuern' : 'GitHub verbinden',
      detail: auth?.needsReauth
        ? presentation.detail
        : 'Für die Workspace-Ansicht ist eine vollständig authentifizierte GitHub-Verbindung nötig.'
    },
    'needs-binding': {
      icon: '⌁',
      title: 'Kein Repository ausgewählt',
      detail: 'Wähle oben rechts im Repository-Umschalter ein Repository oder einen Ordner.'
    },
    'needs-repo': {
      icon: '⌂',
      title: 'Lokales Repository nicht verfügbar',
      detail: 'Prüfe den gewählten lokalen Pfad oder klone das Repository im Profil-Editor.'
    }
  }[gate]

  return (
    <div className="git-tree-empty" data-state={gate}>
      <span className="git-tree-empty-icon" aria-hidden="true">
        {copy.icon}
      </span>
      <strong>{copy.title}</strong>
      <span>{copy.detail}</span>
    </div>
  )
}

function WorktreeRow({ worktree, root }: { worktree: GitWorktreeInfo; root?: string }): JSX.Element {
  return (
    <li className="git-tree-worktree" title={worktree.path}>
      <span className="git-tree-rail" aria-hidden="true">
        └
      </span>
      <span className="git-tree-worktree-main">
        <span className="git-tree-path">{compactWorktreePath(worktree.path, root)}</span>
        <span className="git-tree-head">{worktree.head?.slice(0, 7) ?? 'kein HEAD'}</span>
      </span>
      <span className="git-tree-tags">
        {worktree.bare && <span className="git-tree-tag">bare</span>}
        {worktree.locked && (
          <span className="git-tree-tag warn" title={worktree.locked}>
            gesperrt
          </span>
        )}
        {worktree.prunable && (
          <span className="git-tree-tag danger" title={worktree.prunable}>
            entfernbar
          </span>
        )}
      </span>
    </li>
  )
}

export default function GitWorkspaceTree({
  repoBound,
  repoLabel,
  gitInfo,
  githubAuth
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState({ left: 0, top: 0 })
  const anchorRef = useRef<HTMLDivElement>(null)
  const gate = gitWorkspaceTreeGate({
    authResolved: githubAuth !== null,
    githubUsable: hasUsableGithubAuth(githubAuth),
    repoBound,
    isRepo: Boolean(gitInfo?.isRepo)
  })
  const tree = useMemo(
    () => (gate === 'ready' && gitInfo ? buildGitBranchTree(gitInfo) : undefined),
    [gate, gitInfo]
  )
  const worktreeCount = gitInfo?.worktrees?.length ?? 0

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return

    const positionPopover = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return

      const rect = anchor.getBoundingClientRect()
      const viewportPadding = 14
      const popoverWidth = Math.min(430, window.innerWidth - viewportPadding * 2)
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - popoverWidth - viewportPadding
      )
      setPopoverPosition({ left, top: rect.bottom + 7 })
    }

    positionPopover()
    window.addEventListener('resize', positionPopover)
    return () => window.removeEventListener('resize', positionPopover)
  }, [open])

  return (
    <div ref={anchorRef} className="git-tree-anchor no-drag">
      <button
        type="button"
        className={`git-tree-trigger ${gate === 'ready' ? 'ready' : 'locked'}`}
        aria-label="Git-Worktree- und Branch-Baum"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Read-only Übersicht der lokalen Branches und Worktrees"
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⑂</span>
        <span>
          {gate === 'ready'
            ? `${worktreeCount} Worktree${worktreeCount === 1 ? '' : 's'}`
            : 'Git-Baum'}
        </span>
      </button>
      {open && createPortal(
        <>
          <button
            type="button"
            className="git-tree-backdrop"
            aria-label="Git-Baum schließen"
            onClick={() => setOpen(false)}
          />
          <section
            className="git-tree-popover"
            role="dialog"
            aria-label="Workspace Git-Baum"
            style={popoverPosition}
          >
            <header className="git-tree-headline">
              <span>
                <strong>Branches &amp; Worktrees</strong>
                <small>{repoLabel || 'Workspace'}</small>
              </span>
              <span className="git-tree-readonly">Nur Ansicht</span>
            </header>

            {gate !== 'ready' ? (
              emptyState(gate, githubAuth)
            ) : (
              <div className="git-tree-scroll">
                {tree && tree.branches.length > 0 ? (
                  <ul className="git-tree-branches">
                    {tree.branches.map((branch) => (
                      <li className="git-tree-branch" key={branch.name}>
                        <div className={`git-tree-branch-row ${branch.current ? 'current' : ''}`}>
                          <span className="git-tree-node" aria-hidden="true">
                            {branch.current ? '●' : '○'}
                          </span>
                          <span className="git-tree-branch-name">{branch.name}</span>
                          {branch.current && (
                            <span className="git-tree-tag active">aktuell</span>
                          )}
                          {branch.defaultBranch && !branch.current && (
                            <span className="git-tree-tag">Standard</span>
                          )}
                        </div>
                        {branch.worktrees.length > 0 && (
                          <ul className="git-tree-worktrees">
                            {branch.worktrees.map((worktree) => (
                              <WorktreeRow
                                key={worktree.path}
                                worktree={worktree}
                                root={gitInfo?.root}
                              />
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="git-tree-empty compact">
                    <strong>Keine lokalen Branches gefunden</strong>
                  </div>
                )}

                {tree && tree.detachedWorktrees.length > 0 && (
                  <section className="git-tree-detached">
                    <div className="git-tree-section-label">Detached Worktrees</div>
                    <ul className="git-tree-worktrees">
                      {tree.detachedWorktrees.map((worktree) => (
                        <WorktreeRow
                          key={worktree.path}
                          worktree={worktree}
                          root={gitInfo?.root}
                        />
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </section>
        </>,
        document.body
      )}
    </div>
  )
}
