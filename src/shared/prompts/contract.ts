/**
 * The task contract every subagent receives.
 *
 * DESIGN DECISION: the contract is appended by the MCP layer (`start_agent` /
 * `send_to_agent`), not by the spawn code. One place composes it, so one unit
 * test covers it and no spawn path can ever forget it — the old repo lost the
 * subagent reporting tools exactly because a second spawn path skipped a step.
 *
 * English on purpose: model compliance with imperative English instructions is
 * measurably more reliable than with German ones across the CLIs we drive.
 */

export interface TaskContractInput {
  /**
   * The agent's display name, when it is already known. `start_agent` appends
   * the contract *before* the host allocates the name, so it is optional there;
   * `send_to_agent` knows the name and passes it.
   */
  agentName?: string
  role: string
}

export const CONTRACT_MARKER = '--- Contract'

/**
 * The full contract block appended to a subagent's initial task.
 */
export function buildTaskContract({ agentName, role }: TaskContractInput): string {
  const who = agentName
    ? `You are ${agentName}, the "${role}" agent of this Vertragus workspace.`
    : `You are the "${role}" agent of this Vertragus workspace.`

  return [
    `${CONTRACT_MARKER} (Vertragus) ---`,
    who,
    'You report to an orchestrator agent through MCP tools. Follow these rules for every task:',
    '1. Do the work yourself. Read the repository, change the files, run the checks.',
    '2. When the task is finished, call report_done with a short factual summary of what you changed and how you verified it. Use status "success" only when you verified it, "blocked" when something outside your control stops you, "failed" when you tried and it does not work.',
    '3. If you need a decision, a permission, an interface, or information you cannot obtain yourself, call ask_orchestrator and wait for the answer. Do not guess, do not pick a random option, and do not idle.',
    '4. If ask_orchestrator returns answer: null and a ticket, call it again with that same ticket. Do not rephrase the question and do not open a second question.',
    '5. Send a one-line report_progress on real milestones only, not as a heartbeat.',
    '6. Never stop working silently and never end your turn without either report_done or an open ask_orchestrator.',
    '7. After report_done, stay available: the orchestrator either sends you a follow-up task or stops you.',
    '--- End of contract ---'
  ].join('\n')
}

/**
 * The short reminder appended to every follow-up message typed into an agent's
 * PTY — the full contract would drown the actual instruction.
 */
export function buildReminderSuffix(): string {
  return [
    `${CONTRACT_MARKER} reminder ---`,
    'When done: report_done. When blocked: ask_orchestrator and wait for the answer — do not guess, do not idle.'
  ].join('\n')
}
