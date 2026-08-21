/**
 * The hover card behind the CLI title bar's name — pure, so it tests in plain
 * Node like the panel's viewModel: who this figure is in the Commedia, and
 * what the agent is currently working on.
 *
 * The task line follows live (attach carries the initial note, `terminal:task`
 * the changes). Subagents: last start_agent / follow-up. Orchestrator: latest
 * user CLI submit.
 */
import { loreBlurb } from '@shared/lore'
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
  const taskLine = t('terminal.currentTask', { task: trimmed })
  return lore ? `${lore}\n\n${taskLine}` : taskLine
}
