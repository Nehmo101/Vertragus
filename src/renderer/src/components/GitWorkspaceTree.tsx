import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
  t: TFunction,
  gate: Exclude<GitWorkspaceTreeGate, 'ready'>,
  auth: GithubAuthStatus | null
): JSX.Element {
  const presentation = githubAuthPresentation(auth)
  const copy = {
    'checking-auth': {
      icon: '…',
      title: t('git.empty.checkingAuth.title'),
      detail: t('git.empty.checkingAuth.detail')
    },
    'needs-auth': {
      icon: '◇',
      title: auth?.needsReauth ? t('git.empty.needsAuth.renew') : t('git.empty.needsAuth.connect'),
      detail: auth?.needsReauth
        ? presentation.detail
        : t('git.empty.needsAuth.detail')
    },
    'needs-binding': {
      icon: '⌁',
      title: t('git.empty.needsBinding.title'),
      detail: t('git.empty.needsBinding.detail')
    },
    'needs-repo': {
      icon: '⌂',
      title: t('git.empty.needsRepo.title'),
      detail: t('git.empty.needsRepo.detail')
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
  const { t } = useTranslation()
  return (
    <li className="git-tree-worktree" title={worktree.path}>
      <span className="git-tree-rail" aria-hidden="true">
        └
      </span>
      <span className="git-tree-worktree-main">
        <span className="git-tree-path">{compactWorktreePath(worktree.path, root)}</span>
        <span className="git-tree-head">{worktree.head?.slice(0, 7) ?? t('git.noHead')}</span>
      </span>
      <span className="git-tree-tags">
        {worktree.bare && <span className="git-tree-tag">bare</span>}
        {worktree.locked && (
          <span className="git-tree-tag warn" title={worktree.locked}>
            {t('git.locked')}
          </span>
        )}
        {worktree.prunable && (
          <span className="git-tree-tag danger" title={worktree.prunable}>
            {t('git.prunable')}
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
  const { t } = useTranslation()
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
        aria-label={t('git.triggerAria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('git.triggerTitle')}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⑂</span>
        <span>
          {gate === 'ready'
            ? worktreeCount === 1
              ? t('git.worktreeOne', { n: worktreeCount })
              : t('git.worktreeMany', { n: worktreeCount })
            : t('git.tree')}
        </span>
      </button>
      {open && createPortal(
        <>
          <button
            type="button"
            className="git-tree-backdrop"
            aria-label={t('git.closeAria')}
            onClick={() => setOpen(false)}
          />
          <section
            className="git-tree-popover"
            role="dialog"
            aria-label={t('git.dialogAria')}
            style={popoverPosition}
          >
            <header className="git-tree-headline">
              <span>
                <strong>{t('git.headline')}</strong>
                <small>{repoLabel || t('git.repoFallback')}</small>
              </span>
              <span className="git-tree-readonly">{t('git.readonly')}</span>
            </header>

            {gate !== 'ready' ? (
              emptyState(t, gate, githubAuth)
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
                            <span className="git-tree-tag active">{t('git.current')}</span>
                          )}
                          {branch.defaultBranch && !branch.current && (
                            <span className="git-tree-tag">{t('git.default')}</span>
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
                    <strong>{t('git.noBranches')}</strong>
                  </div>
                )}

                {tree && tree.detachedWorktrees.length > 0 && (
                  <section className="git-tree-detached">
                    <div className="git-tree-section-label">{t('git.detached')}</div>
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
