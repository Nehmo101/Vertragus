import { describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import {
  buildCommands,
  filterCommands,
  isPaletteHotkey,
  stepActiveIndex,
  type PaletteActions,
  type PaletteContext
} from './paletteCommands'

// Titles are asserted against the German source copy, independent of the host locale.
const t = i18n.getFixedT('de')

function createActions(): PaletteActions {
  return {
    navigate: vi.fn(),
    setWorkspaceLayout: vi.fn(),
    togglePanel: vi.fn(),
    startAll: vi.fn(),
    startProfile: vi.fn(),
    focusAgent: vi.fn(),
    toggleTheme: vi.fn(),
    toggleReadable: vi.fn(),
    toggleDensity: vi.fn(),
    editProfile: vi.fn()
  }
}

function createContext(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return {
    profiles: [
      { id: 'p1', name: 'Vertragus Core' },
      { id: 'p2', name: 'Docs Team' }
    ],
    runningAgents: [{ id: 'a1', name: 'Boromir', role: 'Subagent · Backend / API' }],
    actions: createActions(),
    ...overrides
  }
}

describe('buildCommands', () => {
  it('liefert die statischen Befehle (Navigation, Layout, Panels, Ansicht, startAll)', () => {
    const ids = buildCommands(createContext(), t).map((command) => command.id)
    for (const expected of [
      'nav.workspace',
      'nav.inbox',
      'nav.approvals',
      'nav.changes',
      'nav.remote',
      'layout.canvas',
      'layout.tiles',
      'layout.focus',
      'panel.sidebar',
      'panel.orchestrator',
      'agents.startAll',
      'view.theme',
      'view.readable',
      'view.density'
    ]) {
      expect(ids).toContain(expected)
    }
  })

  it('baut je Profil einen Start- und einen Bearbeiten-Befehl', () => {
    const ctx = createContext()
    const commands = buildCommands(ctx, t)
    const titles = commands.map((command) => command.title)
    expect(titles).toContain('Profil starten: Vertragus Core')
    expect(titles).toContain('Profil starten: Docs Team')
    expect(titles).toContain('Profil bearbeiten: Vertragus Core')
    expect(titles).toContain('Profil bearbeiten: Docs Team')

    commands.find((command) => command.id === 'profile.start.p2')?.run()
    expect(ctx.actions.startProfile).toHaveBeenCalledWith('p2')
    commands.find((command) => command.id === 'profile.edit.p1')?.run()
    expect(ctx.actions.editProfile).toHaveBeenCalledWith('p1')
  })

  it('baut je laufendem Agent einen Fokus-Befehl mit Lore-Namen', () => {
    const ctx = createContext()
    const command = buildCommands(ctx, t).find((item) => item.id === 'agent.focus.a1')
    expect(command?.title).toBe('Agent fokussieren: Boromir')
    command?.run()
    expect(ctx.actions.focusAgent).toHaveBeenCalledWith('a1')
  })

  it('kommt ohne Profile/Agents aus (nur statische Befehle)', () => {
    const commands = buildCommands(createContext({ profiles: [], runningAgents: [] }), t)
    expect(commands).toHaveLength(14)
  })

  it('verdrahtet Navigation, Layout und Panels mit den erwarteten Argumenten', () => {
    const ctx = createContext()
    const commands = buildCommands(ctx, t)
    const run = (id: string): void => commands.find((command) => command.id === id)?.run()

    run('nav.workspace')
    expect(ctx.actions.navigate).toHaveBeenCalledWith('')
    run('nav.remote')
    expect(ctx.actions.navigate).toHaveBeenCalledWith('#/remote')
    run('layout.canvas')
    expect(ctx.actions.setWorkspaceLayout).toHaveBeenCalledWith('canvas')
    run('panel.orchestrator')
    expect(ctx.actions.togglePanel).toHaveBeenCalledWith('orchestrator-right')
    run('agents.startAll')
    expect(ctx.actions.startAll).toHaveBeenCalledTimes(1)
  })

  it('enthaelt keine destruktiven Befehle', () => {
    const ids = buildCommands(createContext(), t).map((command) => command.id.toLowerCase())
    for (const id of ids) {
      expect(id).not.toMatch(/stop|kill|delete|remove|clean/)
    }
  })
})

describe('filterCommands', () => {
  const commands = buildCommands(createContext(), t)

  it('liefert bei leerer Eingabe alle Befehle', () => {
    expect(filterCommands(commands, '')).toHaveLength(commands.length)
    expect(filterCommands(commands, '   ')).toHaveLength(commands.length)
  })

  it('matcht case-insensitiv im Titel', () => {
    const hits = filterCommands(commands, 'BOROMIR')
    expect(hits.map((command) => command.id)).toEqual(['agent.focus.a1'])
  })

  it('matcht Schlagworte', () => {
    const hits = filterCommands(commands, 'seitenleiste')
    expect(hits.map((command) => command.id)).toEqual(['panel.sidebar'])
  })

  it('verlangt alle Tokens (UND-Verknuepfung)', () => {
    const hits = filterCommands(commands, 'profil docs')
    expect(hits.map((command) => command.id).sort()).toEqual(['profile.edit.p2', 'profile.start.p2'])
  })

  it('liefert leere Liste ohne Treffer', () => {
    expect(filterCommands(commands, 'xyzzy')).toEqual([])
  })
})

describe('stepActiveIndex', () => {
  it('bewegt sich auf und ab und wickelt an den Enden um', () => {
    expect(stepActiveIndex(0, 1, 3)).toBe(1)
    expect(stepActiveIndex(2, 1, 3)).toBe(0)
    expect(stepActiveIndex(0, -1, 3)).toBe(2)
    expect(stepActiveIndex(1, -1, 3)).toBe(0)
  })

  it('startet aus dem Nichts (Index -1) beim ersten bzw. letzten Eintrag', () => {
    expect(stepActiveIndex(-1, 1, 3)).toBe(0)
    expect(stepActiveIndex(-1, -1, 3)).toBe(2)
  })

  it('liefert -1 fuer leere Listen', () => {
    expect(stepActiveIndex(0, 1, 0)).toBe(-1)
    expect(stepActiveIndex(-1, -1, 0)).toBe(-1)
  })
})

describe('isPaletteHotkey', () => {
  const base = { key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }

  it('erkennt Strg+K und Cmd+K (auch mit grossem K)', () => {
    expect(isPaletteHotkey({ ...base, ctrlKey: true })).toBe(true)
    expect(isPaletteHotkey({ ...base, metaKey: true })).toBe(true)
    expect(isPaletteHotkey({ ...base, key: 'K', ctrlKey: true })).toBe(true)
  })

  it('ignoriert K ohne Mod sowie Alt/Shift-Kombinationen und andere Tasten', () => {
    expect(isPaletteHotkey(base)).toBe(false)
    expect(isPaletteHotkey({ ...base, ctrlKey: true, altKey: true })).toBe(false)
    expect(isPaletteHotkey({ ...base, ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isPaletteHotkey({ ...base, key: 'j', ctrlKey: true })).toBe(false)
  })
})
