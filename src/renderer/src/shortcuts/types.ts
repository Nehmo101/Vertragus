export type ShortcutActionId =
  | 'speech.toggle'
  | 'nav.workspace'
  | 'nav.inbox'
  | 'nav.approvals'
  | 'nav.changes'
  | 'layout.canvas'
  | 'layout.tiles'
  | 'layout.focus'
  | 'agents.startAll'
  | 'panel.sidebarLeft'
  | 'panel.orchestratorRight'
  | (string & {})

export type ShortcutModifier = 'Alt' | 'Control' | 'Meta' | 'Mod' | 'Shift'

export interface ShortcutBinding {
  key: string
  modifiers?: readonly ShortcutModifier[]
}

export type ShortcutPlatform = 'mac' | 'other'

export interface ShortcutHandlerContext {
  actionId: ShortcutActionId
  event: KeyboardEvent
}

export type ShortcutHandler = (context: ShortcutHandlerContext) => boolean | void

export interface ShortcutRegistration {
  actionId: ShortcutActionId
  handler: ShortcutHandler
  context?: string
  priority?: number
  isActive?: () => boolean
}
