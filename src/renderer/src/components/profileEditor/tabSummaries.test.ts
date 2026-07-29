import { describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import type { AgentSlot, WorkspaceProfile } from '@shared/profile'
import {
  automationTabSummary,
  modeTabSummary,
  repoTabSummary,
  skillsTabSummary,
  slotsTabSummary,
  tabSummaries
} from './tabSummaries'

// Summaries are asserted against the German source copy, independent of the host locale.
const t = i18n.getFixedT('de')

function slot(patch: Partial<AgentSlot> = {}): AgentSlot {
  return {
    role: 'worker',
    provider: 'codex',
    model: '',
    count: 1,
    orchestrated: true,
    yolo: false,
    strengths: [],
    weaknesses: [],
    ...patch
  }
}

function profile(patch: Partial<WorkspaceProfile> = {}): WorkspaceProfile {
  return {
    id: 'p1',
    name: 'Test',
    workingDir: '',
    agents: [],
    solo: false,
    skills: [],
    yoloDefault: false,
    sandbox: 'none',
    planner: { mode: 'review', routingMode: 'adaptive', maxParallel: 6, maxRetries: 1 },
    benchmark: { enabled: false },
    multiAgent: { enabled: false, stopLosers: true },
    autoPr: {
      mode: 'off',
      strategy: 'aggregate',
      baseBranch: '',
      qualityGates: [],
      securityGateExcludes: [],
      secretScanner: 'builtin',
      labels: [],
      reviewers: []
    },
    autoGit: { enabled: false, targetBranch: '' },
    ...patch
  }
}

describe('repoTabSummary', () => {
  it('prefers the GitHub binding over the local path', () => {
    const p = profile({
      workingDir: 'C:\\git\\somewhere-else',
      githubRepo: {
        owner: 'uwe',
        repo: 'dragons',
        defaultBranch: 'main',
        localPath: '',
        cloneStatus: 'linked'
      }
    })
    expect(repoTabSummary(p, t)).toBe('uwe/dragons')
  })

  it('falls back to the working directory basename for both path styles', () => {
    expect(repoTabSummary(profile({ workingDir: 'C:\\git\\vertragus' }), t)).toBe('vertragus')
    expect(repoTabSummary(profile({ workingDir: '/home/uwe/vertragus/' }), t)).toBe('vertragus')
  })

  it('names the empty state', () => {
    expect(repoTabSummary(profile(), t)).toBe('Kein Repo verbunden')
  })
})

describe('modeTabSummary', () => {
  it('shows the orchestrated mode with the explicit model', () => {
    const p = profile({
      orchestrator: {
        provider: 'claude',
        model: 'opus',
        permissionMode: 'default',
        autoOpenSubwindows: true
      }
    })
    expect(modeTabSummary(p, t)).toBe('Orchestriert · claude/opus')
  })

  it('appends the effective effort and falls back to the CLI default', () => {
    const withEffort = profile({
      orchestrator: {
        provider: 'claude',
        model: 'sonnet',
        effort: 'xhigh',
        permissionMode: 'default',
        autoOpenSubwindows: true
      }
    })
    expect(modeTabSummary(withEffort, t)).toBe('Orchestriert · claude/sonnet · Extra')

    // A rung the provider cannot serve is shown as the clamped one.
    const clamped = profile({
      orchestrator: {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'max',
        permissionMode: 'default',
        autoOpenSubwindows: true
      }
    })
    expect(modeTabSummary(clamped, t)).toBe('Orchestriert · codex/gpt-5.6-sol · Hoch')

    const cliDefault = profile({
      orchestrator: {
        provider: 'kimi',
        model: '',
        permissionMode: 'default',
        autoOpenSubwindows: true
      }
    })
    expect(modeTabSummary(cliDefault, t)).toBe('Orchestriert · kimi/CLI-Standard')
  })

  it('shows solo mode with the single slot model', () => {
    const p = profile({ solo: true, agents: [slot({ provider: 'claude', model: 'sonnet' })] })
    expect(modeTabSummary(p, t)).toBe('Efficiency Solo · claude/sonnet')
    expect(modeTabSummary(profile({ solo: true }), t)).toBe('Efficiency Solo')
  })

  it('shows the parallel single mode with slot count and singular form', () => {
    expect(modeTabSummary(profile({ agents: [slot(), slot()] }), t)).toBe('Single · 2 Slots parallel')
    expect(modeTabSummary(profile({ agents: [slot()] }), t)).toBe('Single · 1 Slot parallel')
  })
})

describe('slotsTabSummary', () => {
  it('counts slots and distinct providers', () => {
    const p = profile({
      agents: [slot({ provider: 'claude' }), slot({ provider: 'codex' }), slot({ provider: 'codex' })]
    })
    expect(slotsTabSummary(p, t)).toBe('3 Slots · 2 Provider')
  })

  it('adds the instance total only when count multiplies the rows', () => {
    const p = profile({ agents: [slot({ count: 3 }), slot({ provider: 'claude' })] })
    expect(slotsTabSummary(p, t)).toBe('2 Slots · 2 Provider · 4 Agents')
  })

  it('uses the singular and names the empty state', () => {
    expect(slotsTabSummary(profile({ agents: [slot()] }), t)).toBe('1 Slot · 1 Provider')
    expect(slotsTabSummary(profile(), t)).toBe('Keine Slots')
  })
})

describe('automationTabSummary', () => {
  it('combines PR mode/strategy with the auto-git target', () => {
    const p = profile({
      autoPr: { ...profile().autoPr, mode: 'draft-after-checks', strategy: 'aggregate' },
      autoGit: { enabled: true, targetBranch: 'main' }
    })
    expect(automationTabSummary(p, t)).toBe('draft-after-checks · aggregate · Push auf main')
  })

  it('names both disabled states and a missing target branch', () => {
    expect(automationTabSummary(profile(), t)).toBe('Auto-PR aus · Auto-Git aus')
    const missingBranch = profile({ autoGit: { enabled: true, targetBranch: '   ' } })
    expect(automationTabSummary(missingBranch, t)).toBe('Auto-PR aus · Push auf ?')
  })
})

describe('skillsTabSummary', () => {
  const skill = {
    id: 's1',
    name: 'Deploy',
    instructions: 'x',
    source: 'user' as const,
    createdAt: 0,
    updatedAt: 0
  }

  it('counts skills with singular/plural and survives legacy drafts', () => {
    expect(skillsTabSummary(profile({ skills: [skill] }), t)).toBe('1 Skill')
    expect(skillsTabSummary(profile({ skills: [skill, { ...skill, id: 's2' }] }), t)).toBe('2 Skills')
    expect(skillsTabSummary(profile({ skills: undefined }), t)).toBe('Keine Skills')
  })
})

describe('tabSummaries', () => {
  it('returns one line per tab', () => {
    const all = tabSummaries(profile(), t)
    expect(Object.keys(all).sort()).toEqual(['automation', 'mode', 'repo', 'skills', 'slots'])
    for (const line of Object.values(all)) {
      expect(line.length).toBeGreaterThan(0)
    }
  })
})
