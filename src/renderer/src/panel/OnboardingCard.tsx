import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderAuthStatus, ProviderListEntry, VertragusAppApi } from '../../../preload'
import { CloseIcon } from './icons'
import { errorText } from './viewModel'
import {
  authRows,
  authSummary,
  cliSummary,
  firstHealthyProviderId,
  loginCommands,
  onboardingSteps,
  providerRows,
  providerTally,
  type OnboardingStepId
} from './onboardingViewModel'

interface Props {
  bridge: VertragusAppApi
  /** Open the profile editor on the new-profile slot, orchestrator preselected. */
  onNewProfile(providerId?: string): void
  /** Persist `ui.onboardingDismissed` — the card is gone until a reinstall. */
  onDismiss(): void
}

/** How long the copy button stays acknowledged. */
const COPIED_MS = 1_600

/**
 * The first-run card: what the panel shows while there is no profile yet.
 *
 * Four steps, in the order a first run actually fails in: is a CLI installed,
 * is it logged in, is there a profile, press Play. It reuses the channels the
 * app already has (`providers:list` with its health probe, `providers:authStatus`,
 * `profileEditor:open`) rather than growing a wizard of its own — a separate
 * onboarding window would be a second, diverging copy of every one of those.
 *
 * The login step deliberately stops at showing the command. These flows open
 * browsers and print device codes; a PTY puppet typing into them would break on
 * the first prompt change and lie about having logged anybody in.
 *
 * Both probes shell out, so they run on mount and on the explicit ⟳ — the card
 * only exists while it is visible, which is what keeps them off the panel's
 * render path.
 */
export function OnboardingCard({ bridge, onNewProfile, onDismiss }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [providers, setProviders] = useState<ProviderListEntry[] | null>(null)
  const [auth, setAuth] = useState<ProviderAuthStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  /** Bumped by ⟳ — the way to re-probe after logging in elsewhere. */
  const [round, setRound] = useState(0)

  // The reset belongs to the ⟳ handler, not here: on mount all three are
  // already null, and clearing them inside the effect is a synchronous
  // setState during render that the react-hooks rule refuses (rightly — it
  // schedules a second render for state that never differed).
  const recheck = (): void => {
    setProviders(null)
    setAuth(null)
    setError(null)
    setRound((current) => current + 1)
  }

  useEffect(() => {
    let alive = true
    const fail = (cause: unknown): void => {
      if (alive) setError(errorText(cause))
    }
    // Round 0 is the mount and takes the cached health the picker warmed;
    // every later round is the ⟳, and that button exists precisely for the
    // user who just installed a CLI — served from a 30 s cache it would be a
    // no-op exactly when it is pressed. The auth probe needs no such flag: it
    // is uncached by design.
    bridge.listProviders(round > 0 ? { refresh: true } : undefined).then((next) => {
      if (alive) setProviders(next)
    }, fail)
    bridge.listProviderAuth().then((next) => {
      if (alive) setAuth(next)
    }, fail)
    return () => {
      alive = false
    }
  }, [bridge, round])

  const entries = providers ?? []
  const clis = providerRows(t, entries)
  const tally = providerTally(entries)
  // `auth` stays null until the probe answers — passed through as such, so a
  // row that is only waiting is not described as a CLI without a status command.
  const logins = authRows(t, entries, auth)
  const commands = loginCommands(logins)
  const steps = onboardingSteps(t, {
    providersLoaded: providers !== null,
    authLoaded: auth !== null,
    foundCount: tally.found,
    authRows: logins,
    hasProfile: false
  })

  const copy = (command: string): void => {
    setError(null)
    const clipboard = navigator.clipboard
    if (!clipboard) return
    clipboard.writeText(command).then(
      () => {
        setCopied(command)
        window.setTimeout(() => setCopied((current) => (current === command ? null : current)), COPIED_MS)
      },
      (cause) => setError(errorText(cause))
    )
  }

  const body: Record<OnboardingStepId, React.JSX.Element> = {
    clis: (
      <>
        <ul className="panel-onboarding-list">
          {clis.map((row) => (
            <li key={row.id} className="panel-onboarding-row" title={row.title}>
              <span className={`panel-onboarding-dot is-${row.tone}`} />
              <span className="panel-onboarding-name">{row.label}</span>
              <span className="panel-onboarding-detail">{row.detail}</span>
            </li>
          ))}
        </ul>
        <p className="panel-onboarding-note">{cliSummary(t, providers !== null, tally)}</p>
      </>
    ),
    login: (
      <>
        <ul className="panel-onboarding-list">
          {logins.map((row) => (
            <li key={row.id} className="panel-onboarding-row" title={row.title}>
              <span className={`panel-onboarding-dot is-${row.tone}`} />
              <span className="panel-onboarding-name">{row.label}</span>
              <span className="panel-onboarding-detail">{row.stateLabel}</span>
            </li>
          ))}
        </ul>
        <p className="panel-onboarding-note">
          {authSummary(t, providers !== null && auth !== null, logins)}
        </p>
        {commands.map((command) => (
          <button
            key={command}
            type="button"
            className="panel-onboarding-command"
            title={t('panel.onboardingCopy', { command })}
            onClick={() => copy(command)}
          >
            <code>{command}</code>
            <span className="panel-onboarding-copy">
              {copied === command ? t('panel.onboardingCopied') : t('panel.onboardingCopy', { command })}
            </span>
          </button>
        ))}
      </>
    ),
    profile: (
      <>
        <button
          type="button"
          className="panel-new panel-onboarding-action"
          onClick={() => onNewProfile(firstHealthyProviderId(entries))}
        >
          {t('panel.onboardingNewProfile')}
        </button>
        <p className="panel-onboarding-note">{t('panel.onboardingProfileHint')}</p>
      </>
    ),
    run: <p className="panel-onboarding-note">{t('panel.onboardingRunHint')}</p>
  }

  return (
    <section className="panel-section panel-onboarding">
      <h2 className="panel-label">
        {t('panel.onboardingTitle')}
        <button
          type="button"
          className="panel-onboarding-recheck"
          title={t('panel.onboardingRecheck')}
          aria-label={t('panel.onboardingRecheck')}
          onClick={recheck}
        >
          ⟳
        </button>
        <button
          type="button"
          className="panel-icon-button panel-onboarding-dismiss"
          title={t('panel.onboardingDismiss')}
          aria-label={t('panel.onboardingDismiss')}
          onClick={onDismiss}
        >
          <CloseIcon size={11} />
        </button>
      </h2>
      <p className="panel-onboarding-intro">{t('panel.onboardingIntro')}</p>
      <ol className="panel-onboarding-steps">
        {steps.map((step) => (
          <li key={step.id} className={`panel-onboarding-step is-${step.state}`}>
            <span className="panel-onboarding-marker">{step.state === 'done' ? '✓' : step.index}</span>
            <span className="panel-onboarding-step-label">{step.label}</span>
            <div className="panel-onboarding-body">{body[step.id]}</div>
          </li>
        ))}
      </ol>
      {error ? <p className="panel-onboarding-error">{error}</p> : null}
    </section>
  )
}
