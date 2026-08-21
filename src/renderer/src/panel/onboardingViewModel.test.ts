import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@shared/schema/provider'
import type { ProviderAuthStatus, ProviderListEntry } from '../../../preload'
import { translator } from '../i18n'
import {
  authRows,
  authSummary,
  cliSummary,
  firstHealthyProviderId,
  loginCommands,
  onboardingSteps,
  providerRows,
  providerTally,
  shouldShowOnboarding,
  type AuthRow
} from './onboardingViewModel'

const t = translator('de')
const et = translator('en')

function config(id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    label: id.toUpperCase(),
    command: id,
    args: [],
    yoloArgs: [],
    versionArgs: ['--version'],
    systemPromptDelivery: { kind: 'pty' },
    mcp: { kind: 'none' },
    modelDiscovery: { kind: 'none' },
    seedModels: [],
    enabled: true,
    ...overrides
  }
}

/** `health: null` means "the probe has not come back yet". */
function entry(
  id: string,
  health: { available: boolean; version?: string; error?: string } | null
): ProviderListEntry {
  return {
    config: config(id),
    ...(health ? { health: { id, checkedAt: 1_000, ...health } } : {})
  }
}

function status(
  id: string,
  state: ProviderAuthStatus['state'],
  overrides: Partial<ProviderAuthStatus> = {}
): ProviderAuthStatus {
  return { id, state, checkedAt: 1_000, ...overrides }
}

describe('shouldShowOnboarding', () => {
  it('shows only while there is no profile', () => {
    expect(shouldShowOnboarding([], false, true)).toBe(true)
    expect(shouldShowOnboarding([{ id: 'p1' }], false, true)).toBe(false)
  })

  it('stays hidden once the user closed it by hand', () => {
    expect(shouldShowOnboarding([], true, true)).toBe(false)
  })

  it('waits for the data instead of flashing at a user who has profiles', () => {
    // The panel's list starts empty because nothing answered yet — which is
    // indistinguishable from "no profiles" without this flag.
    expect(shouldShowOnboarding([], false, false)).toBe(false)
  })

  it('comes back after the last profile is gone — no "has seen it" memory', () => {
    // A wiped config or a deleted last profile puts the user back where the
    // card helps; nothing about that clears a "seen" flag, so the trigger must
    // not be one.
    expect(shouldShowOnboarding([], false, true)).toBe(true)
  })
})

describe('providerRows', () => {
  it('names the version of an installed CLI', () => {
    const [row] = providerRows(t, [entry('claude', { available: true, version: '2.1.4' })])
    expect(row).toMatchObject({ id: 'claude', label: 'CLAUDE', tone: 'ok', detail: '2.1.4' })
    expect(row?.title).toBe('claude — 2.1.4')
  })

  it('keeps a missing CLI on the list with the reason it failed', () => {
    const [row] = providerRows(t, [
      entry('cursor', { available: false, error: 'spawn cursor ENOENT' })
    ])
    expect(row).toMatchObject({ tone: 'warn', detail: 'spawn cursor ENOENT' })
  })

  it('separates "probe still out" from "not installed"', () => {
    const [row] = providerRows(t, [entry('grok', null)])
    expect(row?.tone).toBe('unknown')
    expect(row?.detail).toBe(t('panel.onboardingCliProbing'))
  })

  it('falls back to a word when the probe answered nothing quotable', () => {
    expect(providerRows(t, [entry('kimi', { available: true })])[0]?.detail).toBe(
      t('panel.onboardingCliFound')
    )
    expect(providerRows(t, [entry('kimi', { available: false })])[0]?.detail).toBe(
      t('panel.onboardingCliMissing')
    )
  })
})

describe('providerTally and firstHealthyProviderId', () => {
  const entries = [
    entry('claude', { available: false, error: 'ENOENT' }),
    entry('codex', { available: true, version: '1.0' }),
    entry('cursor', { available: true, version: '2.0' }),
    entry('grok', null)
  ]

  it('counts only the CLIs that actually answered', () => {
    expect(providerTally(entries)).toEqual({ found: 2, total: 4 })
  })

  it('preselects the first installed provider, in picker order', () => {
    expect(firstHealthyProviderId(entries)).toBe('codex')
  })

  it('hands out no guess when nothing is installed', () => {
    expect(firstHealthyProviderId([entry('claude', { available: false })])).toBeUndefined()
    expect(firstHealthyProviderId([entry('claude', null)])).toBeUndefined()
  })
})

describe('authRows', () => {
  const entries = [
    entry('claude', { available: true, version: '2.1.4' }),
    entry('cursor', { available: true, version: '2.0' }),
    entry('grok', { available: false, error: 'ENOENT' }),
    entry('kimi', null)
  ]

  it('asks only about CLIs that are actually installed', () => {
    const rows = authRows(t, entries, [status('claude', 'logged-in')])
    expect(rows.map((row) => row.id)).toEqual(['claude', 'cursor'])
  })

  it('maps every state onto its own tone and label', () => {
    const rows = authRows(t, entries, [
      status('claude', 'logged-in', { detail: 'Logged in as ada' }),
      status('cursor', 'logged-out', { detail: 'Not logged in', loginCommand: 'cursor login' })
    ])
    expect(rows[0]).toMatchObject({ tone: 'ok', stateLabel: t('panel.onboardingAuthIn') })
    expect(rows[0]?.title).toBe(`${t('panel.onboardingAuthIn')} — Logged in as ada`)
    expect(rows[1]).toMatchObject({
      tone: 'warn',
      stateLabel: t('panel.onboardingAuthOut'),
      loginCommand: 'cursor login'
    })
  })

  it('says unknown — and why — for a CLI without a status probe', () => {
    const rows = authRows(t, [entries[0]!], [status('claude', 'unknown')])
    expect(rows[0]).toMatchObject({ tone: 'unknown', state: 'unknown' })
    expect(rows[0]?.title).toContain(t('panel.onboardingAuthNoProbe'))
  })

  it('treats a status that has not arrived yet as unknown, never as fine', () => {
    expect(authRows(t, [entries[0]!], [])[0]?.state).toBe('unknown')
  })
})

describe('loginCommands', () => {
  const row = (overrides: Partial<AuthRow>): AuthRow => ({
    id: 'x',
    label: 'X',
    tone: 'warn',
    state: 'logged-out',
    stateLabel: 'out',
    title: 'out',
    ...overrides
  })

  it('offers a command only where there is something to fix', () => {
    expect(
      loginCommands([
        row({ id: 'a', loginCommand: 'a login' }),
        row({ id: 'b', state: 'logged-in', tone: 'ok', loginCommand: 'b login' }),
        row({ id: 'c', state: 'unknown', tone: 'unknown', loginCommand: 'c login' })
      ])
    ).toEqual(['a login'])
  })

  it('skips a logged-out provider that declares no login args', () => {
    expect(loginCommands([row({ id: 'a' })])).toEqual([])
  })

  it('shows one command once, even when two providers share it', () => {
    expect(
      loginCommands([
        row({ id: 'a', loginCommand: 'claude auth login' }),
        row({ id: 'b', loginCommand: 'claude auth login' })
      ])
    ).toEqual(['claude auth login'])
  })
})

describe('onboardingSteps', () => {
  const progress = {
    providersLoaded: true,
    foundCount: 0,
    authRows: [] as AuthRow[],
    hasProfile: false
  }
  const stateOf = (steps: ReturnType<typeof onboardingSteps>): string[] =>
    steps.map((step) => step.state)

  it('activates exactly one step — the first unfinished one', () => {
    expect(stateOf(onboardingSteps(t, progress))).toEqual(['active', 'todo', 'todo', 'todo'])
  })

  it('keeps step 1 open while the provider list is still loading', () => {
    const steps = onboardingSteps(t, { ...progress, providersLoaded: false, foundCount: 2 })
    expect(steps[0]?.state).toBe('active')
  })

  it('moves on once a CLI was found', () => {
    expect(stateOf(onboardingSteps(t, { ...progress, foundCount: 1 }))).toEqual([
      'done',
      'active',
      'todo',
      'todo'
    ])
  })

  const signedIn: AuthRow = {
    id: 'claude',
    label: 'Claude',
    tone: 'ok',
    state: 'logged-in',
    stateLabel: 'in',
    title: 'in'
  }

  it('finishes the login step only when every listed CLI is signed in', () => {
    expect(
      stateOf(onboardingSteps(t, { ...progress, foundCount: 1, authRows: [signedIn] }))
    ).toEqual(['done', 'done', 'active', 'todo'])
  })

  it('keeps the login step open while one CLI stays unknown', () => {
    // An unanswerable status is not a signed-in one; the step that shows the
    // login command has to stay reachable.
    const unknown: AuthRow = { ...signedIn, id: 'kimi', state: 'unknown', tone: 'unknown' }
    expect(
      stateOf(onboardingSteps(t, { ...progress, foundCount: 1, authRows: [signedIn, unknown] }))
    ).toEqual(['done', 'active', 'todo', 'todo'])
  })

  it('never calls the run step done — a first run needs a profile', () => {
    const steps = onboardingSteps(t, {
      providersLoaded: true,
      foundCount: 1,
      authRows: [signedIn],
      hasProfile: true
    })
    expect(stateOf(steps)).toEqual(['done', 'done', 'done', 'active'])
  })

  it('numbers the steps and labels them in the active language', () => {
    expect(onboardingSteps(t, progress).map((step) => step.index)).toEqual([1, 2, 3, 4])
    expect(onboardingSteps(et, progress)[0]?.label).toBe('CLIs found')
    expect(onboardingSteps(t, progress)[0]?.label).toBe('Gefundene CLIs')
  })
})

describe('the two summary lines', () => {
  it('tells loading, empty and counted apart', () => {
    expect(cliSummary(t, false, { found: 0, total: 0 })).toBe(t('panel.onboardingCliLoading'))
    expect(cliSummary(t, true, { found: 0, total: 6 })).toBe(t('panel.onboardingCliNone'))
    expect(cliSummary(t, true, { found: 2, total: 6 })).toBe(
      t('panel.onboardingCliCount', { found: 2, total: 6 })
    )
  })

  it('does the same for the login list', () => {
    expect(authSummary(t, false, [])).toBe(t('panel.onboardingAuthLoading'))
    expect(authSummary(t, true, [])).toBe(t('panel.onboardingAuthNone'))
    expect(
      authSummary(t, true, [
        { id: 'a', label: 'A', tone: 'ok', state: 'logged-in', stateLabel: 'in', title: 'in' }
      ])
    ).toBe(t('panel.onboardingAuthHint'))
  })
})
