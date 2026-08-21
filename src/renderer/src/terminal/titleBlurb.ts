/**
 * The hover card behind the CLI title bar's name — pure, so it tests in plain
 * Node like the panel's viewModel: who this figure is in the Commedia, and
 * what the agent is currently working on.
 *
 * The task line follows the orchestrator's assignments live (attach carries
 * the initial note, `terminal:task` the changes). For the orchestrator itself
 * — which is never assigned a task through the tools — the note is the last
 * task it delegated, and the line says so.
 */
import { loreBlurb } from '@shared/lore'
import { ORCHESTRATOR_ROLE_ID } from '@shared/prompts/roles'
import type { Locale, Translate } from '../i18n'
import type { TerminalAgentMeta } from '../../../preload'

export function metaBlurb(
  t: Translate,
  locale: Locale,
  meta: Pick<TerminalAgentMeta, 'name' | 'role'>,
  task: string | undefined
): string | undefined {
  const lore = loreBlurb(meta.name, locale)
  const trimmed = task?.trim()
  if (!trimmed) return lore
  const taskLine =
    meta.role === ORCHESTRATOR_ROLE_ID
      ? t('terminal.lastDelegated', { task: trimmed })
      : t('terminal.currentTask', { task: trimmed })
  return lore ? `${lore}\n\n${taskLine}` : taskLine
}
