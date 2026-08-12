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
 *
 * Two reporting dialects share this file:
 * - `mcp` — call report_done / ask_orchestrator / report_progress (byte-stable).
 * - `sentinel` — print `@@VERTRAGUS:…@@{json}@@END@@` lines for PTY-only CLIs.
 *   Markers are taught as SPLIT halves separated by non-whitespace words so a
 *   TUI echo of the contract can never form a joined start token (see the
 *   echo-safety test). The host parser requires a full start…end pair.
 */

/** How a subagent reports back to the orchestrator. */
export type ReportingMode = 'mcp' | 'sentinel'

export interface TaskContractInput {
  /**
   * The agent's display name, when it is already known. `start_agent` appends
   * the contract *before* the host allocates the name, so it is optional there;
   * `send_to_agent` knows the name and passes it.
   */
  agentName?: string
  role: string
  /**
   * Defaults to `mcp` so existing callers stay byte-identical. Sentinel is for
   * providers with `mcp.kind: 'none'` (e.g. Ollama).
   */
  reporting?: ReportingMode
}

export const CONTRACT_MARKER = '--- Contract'

/**
 * The full contract block appended to a subagent's initial task.
 */
export function buildTaskContract(input: TaskContractInput): string {
  const reporting = input.reporting ?? 'mcp'
  return reporting === 'sentinel' ? buildSentinelContract(input) : buildMcpContract(input)
}

/**
 * The short reminder appended to every follow-up message typed into an agent's
 * PTY — the full contract would drown the actual instruction.
 */
export function buildReminderSuffix(reporting: ReportingMode = 'mcp'): string {
  if (reporting === 'sentinel') {
    return [
      `${CONTRACT_MARKER} reminder ---`,
      'When done: print a DONE sentinel line (split halves as taught). When blocked: print an ASK sentinel line and wait — do not guess, do not idle.'
    ].join('\n')
  }
  return [
    `${CONTRACT_MARKER} reminder ---`,
    'When done: report_done. When blocked: ask_orchestrator and wait for the answer — do not guess, do not idle.'
  ].join('\n')
}

function whoLine(agentName: string | undefined, role: string): string {
  return agentName
    ? `You are ${agentName}, the "${role}" agent of this Vertragus workspace.`
    : `You are the "${role}" agent of this Vertragus workspace.`
}

/** MCP wording — keep byte-stable; tests and live agents depend on the text. */
function buildMcpContract({ agentName, role }: TaskContractInput): string {
  return [
    `${CONTRACT_MARKER} (Vertragus) ---`,
    whoLine(agentName, role),
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
 * Sentinel wording for PTY-only agents.
 *
 * Every start marker is taught as two halves with at least one non-whitespace
 * word between them (`immediately followed by`). Whitespace-stripping a TUI
 * echo therefore cannot produce `@@VERTRAGUS:…@@`. The end marker is split the
 * same way so it never sits adjacent to a start half in the contract text.
 */
function buildSentinelContract({ agentName, role }: TaskContractInput): string {
  return [
    `${CONTRACT_MARKER} (Vertragus) ---`,
    whoLine(agentName, role),
    'You report to an orchestrator by printing sentinel lines on your terminal (not MCP tools). Follow these rules for every task:',
    '1. Do the work yourself. Read the repository, change the files, run the checks.',
    '2. When the task is finished, print one DONE report line of at most 700 characters. Build the start marker by writing `@@VERT` immediately followed by `RAGUS:DONE@@` (no space, no other characters between them). Then print compact JSON like {"summary":"what you changed and verified","status":"success"} — status may be success, blocked, or failed; omit status to mean success. Then terminate by writing `@@` immediately followed by `END@@`. Never write the joined start marker anywhere except in an actual report line.',
    '3. If you need a decision, a permission, an interface, or information you cannot obtain yourself, print one ASK report line the same way: build the start marker by writing `@@VERT` immediately followed by `RAGUS:ASK@@`, then compact JSON {"question":"…"}, then `@@` immediately followed by `END@@`. Wait for the orchestrator to type an answer into your terminal. Do not guess, do not pick a random option, and do not idle.',
    '4. If you already asked and are still waiting, do not print a second ASK. Keep waiting for the typed answer; do not rephrase and do not open a second question.',
    '5. On real milestones only (not a heartbeat), print one PROGRESS line: build the start marker by writing `@@VERT` immediately followed by `RAGUS:PROGRESS@@`, then compact JSON {"note":"…"}, then `@@` immediately followed by `END@@`.',
    '6. Never stop working silently and never end your turn without either a DONE report line or an open ASK waiting for an answer.',
    '7. After a DONE report line, stay available: the orchestrator either sends you a follow-up task or stops you.',
    '--- End of contract ---'
  ].join('\n')
}
