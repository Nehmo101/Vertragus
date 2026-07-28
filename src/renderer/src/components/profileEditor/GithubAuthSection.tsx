import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { GithubAuthStatus } from '@shared/ipc'
import InfoTip from '@renderer/components/InfoTip'
import {
  assertValidGithubAuthStatus,
  githubAuthPresentation,
  hasUsableGithubAuth
} from '@renderer/store/githubAuth'
import { HELP } from './help'

interface GithubAuthSectionProps {
  githubAuth: GithubAuthStatus | null
  githubAuthBusy: boolean
  terminalLoginRunning: boolean
  onLogin: () => void
  onLogout: () => void
  onTerminalLogin: () => void
}

/** GitHub-Verbindung: OAuth status plus Verbinden/Abmelden/Terminal-Login actions. */
const GithubAuthSection = memo(function GithubAuthSection({
  githubAuth,
  githubAuthBusy,
  terminalLoginRunning,
  onLogin,
  onLogout,
  onTerminalLogin
}: GithubAuthSectionProps): JSX.Element {
  const { t } = useTranslation()
  // The OAuth status crosses the IPC bridge from main; validate its shape before
  // any connect/login action trusts it. A malformed payload is rejected, not used.
  let githubAuthError = ''
  if (githubAuth) {
    try {
      assertValidGithubAuthStatus(githubAuth)
    } catch (error) {
      githubAuthError = error instanceof Error ? error.message : String(error)
    }
  }
  const githubAuthUsable = !githubAuthError && hasUsableGithubAuth(githubAuth)
  const githubAuthView = githubAuthPresentation(githubAuth)

  return (
    <section className="github-repo-field" aria-labelledby="github-auth-heading">
      <div className="field-label" id="github-auth-heading">
        {t('profile.github.heading')} <InfoTip text={t(HELP.githubAuth)} />
      </div>
      <div className="github-auth-row">
        <div className="github-auth-status" aria-live="polite" title={githubAuthView.detail}>
          <span className={githubAuthUsable ? 'github-auth-ok' : 'github-auth-warn'}>●</span>
          {githubAuthView.detail}
          {githubAuthUsable && githubAuth.scopes.length > 0
            ? ` · ${githubAuth.scopes.join(', ')}`
            : ''}
        </div>
        {!githubAuthUsable && (
          <button
            type="button"
            className="btn-secondary browse-btn"
            disabled={githubAuthBusy || terminalLoginRunning || Boolean(githubAuthError)}
            onClick={() => onLogin()}
          >
            {githubAuthView.label === 'Erneuern' ? t('profile.github.renew') : t('profile.github.connect')}
          </button>
        )}
        {githubAuthUsable && (
          <button
            type="button"
            className="btn-secondary browse-btn"
            disabled={githubAuthBusy || terminalLoginRunning}
            onClick={() => onLogout()}
          >
            {t('profile.github.logout')}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary browse-btn"
          title={t('profile.github.terminalTitle')}
          disabled={githubAuthBusy || terminalLoginRunning}
          onClick={() => onTerminalLogin()}
        >
          {t('profile.github.terminalLogin')}
        </button>
      </div>
      {githubAuthError && (
        <div className="automation-validation-error" role="alert">
          {githubAuthError}
        </div>
      )}
    </section>
  )
})

export default GithubAuthSection
