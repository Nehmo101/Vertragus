import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '@renderer/components/ui/Modal'
import { shouldIgnoreShortcutEvent } from '@renderer/shortcuts/eventGate'
import { isMainWindowRoute } from '@renderer/shortcuts/appShortcuts'
import { useAppStore } from '@renderer/store/useAppStore'
import { useLayoutStore } from '@renderer/store/layoutStore'
import {
  buildCommands,
  filterCommands,
  isPaletteHotkey,
  stepActiveIndex,
  type PaletteCommand,
  type PaletteContext
} from './paletteCommands'
import styles from './CommandPalette.module.css'

/* Command palette (Mod+K). All visible copy comes from i18n keys. */

/**
 * Snapshot of the store state the palette needs, wired to exactly the store
 * actions the visible controls use: Sidebar navigation sets the hash, the
 * per-profile start runs selectProfile + startAll (the sidebar start button),
 * panel toggles run layoutStore.toggleCollapsed, focus uses setSelectedAgent.
 */
export function collectPaletteContext(): PaletteContext {
  const app = useAppStore.getState()
  return {
    profiles: app.profiles.map((profile) => ({ id: profile.id, name: profile.name })),
    runningAgents: app.agents
      .filter((agent) => agent.status === 'running' || agent.status === 'waiting')
      .map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })),
    actions: {
      navigate: (route) => {
        window.location.hash = route
      },
      setWorkspaceLayout: (layout) => useAppStore.getState().setWorkspaceLayout(layout),
      togglePanel: (id) => useLayoutStore.getState().toggleCollapsed(id),
      startAll: () => {
        void useAppStore.getState().startAll()
      },
      startProfile: (profileId) => {
        void (async () => {
          const selected = await useAppStore.getState().selectProfile(profileId)
          if (selected) void useAppStore.getState().startAll()
        })()
      },
      focusAgent: (agentId) => {
        window.location.hash = ''
        useAppStore.getState().setSelectedAgent(agentId)
      },
      toggleTheme: () => useAppStore.getState().toggleTheme(),
      toggleReadable: () => useAppStore.getState().toggleCliReadable(),
      toggleDensity: () => {
        const state = useAppStore.getState()
        state.setUiDensity(state.uiDensity === 'compact' ? 'comfortable' : 'compact')
      },
      editProfile: (profileId) => {
        const state = useAppStore.getState()
        const profile = state.profiles.find((item) => item.id === profileId)
        if (profile) state.openEditor(profile)
      }
    }
  }
}

/**
 * Mounted once in App.tsx (main window only; the #/voice and #/pane branches
 * return earlier). Owns its Mod+K window listener instead of registering in
 * shortcuts/bindings.ts, but applies the same guards: shouldIgnoreShortcutEvent
 * (inputs, IME, repeat) and isMainWindowRoute.
 */
export default function CommandPalette(): JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [commands, setCommands] = useState<readonly PaletteCommand[]>([])
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPaletteHotkey(event)) return
      if (open) {
        // Toggle-close must also work while the palette's own input has focus.
        event.preventDefault()
        setOpen(false)
        return
      }
      if (shouldIgnoreShortcutEvent(event) || !isMainWindowRoute()) return
      event.preventDefault()
      // Build the command list at open time so profiles/agents are current.
      setCommands(buildCommands(collectPaletteContext(), t))
      setQuery('')
      setActiveIndex(0)
      setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, t])

  if (!open) return null

  const visible = filterCommands(commands, query)
  const clampedIndex = visible.length === 0 ? -1 : Math.min(activeIndex, visible.length - 1)

  const close = (): void => setOpen(false)
  const runCommand = (command: PaletteCommand): void => {
    // Close first: the Modal restores focus to the trigger on unmount, and the
    // command may open other UI (editor modal, route change) afterwards.
    setOpen(false)
    command.run()
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(stepActiveIndex(clampedIndex, delta, visible.length))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const command = clampedIndex >= 0 ? visible[clampedIndex] : undefined
      if (command) runCommand(command)
    }
    // Escape is handled centrally by the Modal primitive (useEscapeToClose).
  }

  return (
    <Modal
      onClose={close}
      size="sm"
      className={styles.palette}
      label={t('palette.label')}
      initialFocus={inputRef}
    >
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-palette-list"
        aria-activedescendant={clampedIndex >= 0 ? `command-palette-option-${clampedIndex}` : undefined}
        aria-label={t('palette.searchAria')}
        placeholder={t('palette.searchPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
        }}
        onKeyDown={onInputKeyDown}
      />
      <ul
        id="command-palette-list"
        className={styles.list}
        role="listbox"
        aria-label={t('palette.listAria')}
      >
        {visible.map((command, index) => (
          <li
            key={command.id}
            id={`command-palette-option-${index}`}
            role="option"
            aria-selected={index === clampedIndex}
            className={index === clampedIndex ? `${styles.item} ${styles.itemActive}` : styles.item}
            onMouseEnter={() => setActiveIndex(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand(command)}
          >
            {command.title}
          </li>
        ))}
      </ul>
      {visible.length === 0 && (
        <div className={styles.empty} role="status">
          {t('palette.noMatches')}
        </div>
      )}
    </Modal>
  )
}
