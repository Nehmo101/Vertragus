/**
 * Pure shaping for the panel's first-run card (WP-7). All logic lives here so
 * it runs in plain Node tests; OnboardingCard.tsx only renders what this
 * returns.
 *
 * The card is a CARD, not a wizard window: it sits in the panel the user
 * already has, uses the channels the app already has, and vanishes the moment
 * the first profile is saved. Which is also its trigger — "there is no profile
 * yet" is a fact about the store, true again after a reinstall, and needs
 * nothing persisted to stay honest. The only persisted bit is the opposite
 * claim: the user closed it on purpose (`ui.onboardingDismissed`).
 *
 * The tone vocabulary is deliberately three-valued everywhere. A CLI whose
 * probe has not come back is not "missing", and a provider with no status
 * command is not "logged out" — both are `unknown`, and the copy says so. A
 * first-run surface that guesses is worse than one that admits.
 */
import type { ProviderAuthStatus, ProviderListEntry } from '../../../preload'
import type { Translate } from '../i18n'

/** Green / amber / grey — the dot beside a row. */
export type OnboardingTone = 'ok' | 'warn' | 'unknown'

/**
 * Show the first-run card?
 *
 * Deliberately derived from the profile list rather than from a "has seen it"
 * flag: a reinstall, a wiped config or a deleted last profile all put the user
 * back where the card helps, and none of them would clear such a flag.
 *
 * `ready` is what keeps that from flashing at everybody: the panel's profile
 * list starts out empty because nothing has answered yet, not because there is
 * nothing — and "no profiles" is exactly the state this card reacts to. Until
 * both the list and the settings have come back, the honest answer is "not
 * yet", not "no profiles".
 */
export function shouldShowOnboarding(
  profiles: readonly { id: string }[],
  dismissed: boolean,
  ready: boolean
): boolean {
  return ready && profiles.length === 0 && !dismissed
}

export interface ProviderRow {
  id: string
  label: string
  tone: OnboardingTone
  /** The version line, the failure, or "still probing". */
  detail: string
  title: string
}

/**
 * One row per known provider — the missing ones included, because "claude is
 * not on this machine" is the answer the user came for. `health` absent means
 * the probe is still out, which is its own tone rather than a silent "no".
 */
export function providerRows(
  t: Translate,
  entries: readonly ProviderListEntry[]
): ProviderRow[] {
  return entries.map((entry) => {
    const { config, health } = entry
    const tone: OnboardingTone = !health ? 'unknown' : health.available ? 'ok' : 'warn'
    const detail = !health
      ? t('panel.onboardingCliProbing')
      : health.available
        ? (health.version ?? health.detail ?? t('panel.onboardingCliFound'))
        : (health.error ?? health.detail ?? t('panel.onboardingCliMissing'))
    return {
      id: config.id,
      label: config.label,
      tone,
      detail,
      title: `${config.command} — ${detail}`
    }
  })
}

/** How many of the known CLIs actually answered their version probe. */
export function providerTally(entries: readonly ProviderListEntry[]): {
  found: number
  total: number
} {
  return {
    found: entries.filter((entry) => entry.health?.available === true).length,
    total: entries.length
  }
}

/**
 * The provider a new profile should start on: the first installed one, in the
 * preset order the picker already uses. Undefined when nothing is installed —
 * the editor then keeps its own fallback rather than being handed a guess.
 */
export function firstHealthyProviderId(
  entries: readonly ProviderListEntry[]
): string | undefined {
  return entries.find((entry) => entry.health?.available === true)?.config.id
}

export interface AuthRow {
  id: string
  label: string
  tone: OnboardingTone
  state: ProviderAuthStatus['state']
  stateLabel: string
  /** The exact command to type. Absent when the descriptor declares none. */
  loginCommand?: string
  title: string
}

const AUTH_TONE: Record<ProviderAuthStatus['state'], OnboardingTone> = {
  'logged-in': 'ok',
  'logged-out': 'warn',
  unknown: 'unknown'
}

/**
 * Login rows for the CLIs that are actually installed.
 *
 * Filtered on health for a reason: "you are not logged into a CLI you do not
 * have" is noise that pushes the row that matters off the card. A provider
 * that is installed but whose status has not come back yet is listed as
 * `unknown` — the same honest placeholder as a CLI that has no status probe at
 * all, with its own explanation in the title.
 */
export function authRows(
  t: Translate,
  entries: readonly ProviderListEntry[],
  statuses: readonly ProviderAuthStatus[]
): AuthRow[] {
  const byId = new Map(statuses.map((status) => [status.id, status]))
  const stateLabel: Record<ProviderAuthStatus['state'], string> = {
    'logged-in': t('panel.onboardingAuthIn'),
    'logged-out': t('panel.onboardingAuthOut'),
    unknown: t('panel.onboardingAuthUnknown')
  }
  return entries
    .filter((entry) => entry.health?.available === true)
    .map((entry) => {
      const status = byId.get(entry.config.id)
      const state = status?.state ?? 'unknown'
      const detail = status?.detail ?? t('panel.onboardingAuthNoProbe')
      return {
        id: entry.config.id,
        label: entry.config.label,
        tone: AUTH_TONE[state],
        state,
        stateLabel: stateLabel[state],
        ...(status?.loginCommand ? { loginCommand: status.loginCommand } : {}),
        title: `${stateLabel[state]} — ${detail}`
      }
    })
}

/**
 * The login commands worth showing, deduplicated and in row order.
 *
 * Only for rows that are actually logged out: printing "run `claude auth
 * login`" next to an account that is already signed in trains the user to
 * ignore the card. An `unknown` row gets no command either — we do not know
 * there is anything to fix, and this affordance is deliberately humble: it
 * shows the line to type, it does not claim to be able to type it.
 */
export function loginCommands(rows: readonly AuthRow[]): string[] {
  const seen = new Set<string>()
  const commands: string[] = []
  for (const row of rows) {
    if (row.state !== 'logged-out' || !row.loginCommand) continue
    if (seen.has(row.loginCommand)) continue
    seen.add(row.loginCommand)
    commands.push(row.loginCommand)
  }
  return commands
}

export type OnboardingStepId = 'clis' | 'login' | 'profile' | 'run'
/** `done` behind you, `active` the one step to act on, `todo` still ahead. */
export type OnboardingStepState = 'done' | 'active' | 'todo'

export interface OnboardingStep {
  id: OnboardingStepId
  /** 1-based, for the marker beside the label. */
  index: number
  label: string
  state: OnboardingStepState
}

export interface OnboardingProgress {
  /** False until `providers:list` has answered once. */
  providersLoaded: boolean
  foundCount: number
  authRows: readonly AuthRow[]
  hasProfile: boolean
}

/**
 * The four steps with exactly ONE active: the first unfinished one. A checklist
 * that highlights everything highlights nothing.
 *
 * `profile` and `run` can only be finished by leaving this card behind — the
 * card unmounts as soon as a profile exists — so their `done` branches are
 * unreachable in the panel and reachable in a test, which is the point of
 * computing them here instead of hard-coding two `todo`s.
 */
export function onboardingSteps(t: Translate, progress: OnboardingProgress): OnboardingStep[] {
  const loggedIn =
    progress.authRows.length > 0 &&
    progress.authRows.every((row) => row.state === 'logged-in')
  const done: Record<OnboardingStepId, boolean> = {
    clis: progress.providersLoaded && progress.foundCount > 0,
    login: loggedIn,
    profile: progress.hasProfile,
    // Never done while this card is on screen: a first run needs a profile,
    // and a saved profile takes the card with it.
    run: false
  }
  const labels: Record<OnboardingStepId, string> = {
    clis: t('panel.onboardingStepClis'),
    login: t('panel.onboardingStepLogin'),
    profile: t('panel.onboardingStepProfile'),
    run: t('panel.onboardingStepRun')
  }
  const order: OnboardingStepId[] = ['clis', 'login', 'profile', 'run']
  const active = order.find((id) => !done[id])
  return order.map((id, index) => ({
    id,
    index: index + 1,
    label: labels[id],
    state: done[id] ? 'done' : id === active ? 'active' : 'todo'
  }))
}

/**
 * The one line under the CLI list: still probing, none found, or the tally.
 * Separate from the rows so the empty case cannot be a row that says nothing.
 */
export function cliSummary(
  t: Translate,
  loaded: boolean,
  tally: { found: number; total: number }
): string {
  if (!loaded) return t('panel.onboardingCliLoading')
  if (tally.found === 0) return t('panel.onboardingCliNone')
  return t('panel.onboardingCliCount', tally)
}

/** The one line under the login list; same three-way honesty as above. */
export function authSummary(
  t: Translate,
  loaded: boolean,
  rows: readonly AuthRow[]
): string {
  if (!loaded) return t('panel.onboardingAuthLoading')
  if (rows.length === 0) return t('panel.onboardingAuthNone')
  return t('panel.onboardingAuthHint')
}
