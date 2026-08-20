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
  /**
   * D4: under the `ask-orchestrator` policy the contract gains one rule —
   * clear risky actions through the orchestrator first. Unset (the `yolo` and
   * `ask-user` tiers) keeps the contract byte-identical to before D4; the
   * enforcement there is the CLI's own permission layer, not the prompt.
   */
  approvals?: 'ask-orchestrator'
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

/** What C4 knows about the work a `baseBranch` carries — from its `agent_done`. */
export interface HandoffInput {
  agentName: string
  role: string
  branch: string
  summary: string
  status?: string
  headSha?: string
  changedFiles?: readonly string[]
  uncommitted?: boolean
}

export const HANDOFF_MARKER = '--- Handoff'
const HANDOFF_SUMMARY_MAX = 700
const HANDOFF_FILES_MAX = 20

/**
 * C4: the handoff block `start_agent` appends to the task (before the
 * contract) when `baseBranch` points at another agent's reported work — so a
 * reviewer starts from the predecessor's own report and file list instead of
 * reconstructing the diff from the orchestrator's prose.
 */
export function buildHandoffBlock(input: HandoffInput): string {
  const summary =
    input.summary.length <= HANDOFF_SUMMARY_MAX
      ? input.summary
      : `${input.summary.slice(0, HANDOFF_SUMMARY_MAX - 1)}…`
  const files = input.changedFiles ?? []
  const shownFiles = files.slice(0, HANDOFF_FILES_MAX)
  const moreFiles = files.length - shownFiles.length
  return [
    `${HANDOFF_MARKER} (Vertragus) ---`,
    `Your branch starts from "${input.branch}", which carries work reported done by ${input.agentName} (${input.role}).`,
    `Their report${input.status ? ` (${input.status})` : ''}: ${summary}`,
    ...(input.headSha ? [`Branch HEAD at handoff: ${input.headSha}`] : []),
    ...(shownFiles.length > 0
      ? [`Files they touched: ${shownFiles.join(', ')}${moreFiles > 0 ? ` (+${moreFiles} more)` : ''}`]
      : []),
    ...(input.uncommitted
      ? ['Note: their worktree still held uncommitted changes — the branch may not carry everything the report claims.']
      : []),
    'Verify against the actual content of your checkout, not against this report alone.',
    '--- End of handoff ---'
  ].join('\n')
}

function whoLine(agentName: string | undefined, role: string): string {
  return agentName
    ? `You are ${agentName}, the "${role}" agent of this Vertragus workspace.`
    : `You are the "${role}" agent of this Vertragus workspace.`
}

/**
 * Rules are numbered at build time so the D4 approval rule can slot in without
 * hand-renumbering — with `approvals` unset the joined text is byte-identical
 * to the pre-D4 contract (the snapshot test pins that).
 */
function numbered(rules: readonly string[]): string[] {
  return rules.map((rule, index) => `${index + 1}. ${rule}`)
}

/** MCP wording — keep byte-stable; tests and live agents depend on the text. */
function buildMcpContract({ agentName, role, approvals }: TaskContractInput): string {
  const rules = [
    'Do the work yourself. Read the repository, change the files, run the checks.',
    'When the task is finished, call report_done with a short factual summary of what you changed and how you verified it. Use status "success" only when you verified it, "blocked" when something outside your control stops you, "failed" when you tried and it does not work.',
    'If you need a decision, a permission, an interface, or information you cannot obtain yourself, call ask_orchestrator and wait for the answer. Do not guess, do not pick a random option, and do not idle.',
    ...(approvals === 'ask-orchestrator'
      ? [
          'Before an action that is hard to undo or that reaches beyond your worktree — deleting files outside it, installing software system-wide, pushing branches, or changing state on an external service — call ask_orchestrator and wait for the approval. Ordinary work inside your worktree needs no approval.'
        ]
      : []),
    'If ask_orchestrator returns answer: null and a ticket, call it again with that same ticket. Do not rephrase the question and do not open a second question.',
    'Send a one-line report_progress on real milestones only, not as a heartbeat.',
    'Never stop working silently and never end your turn without either report_done or an open ask_orchestrator.',
    'After report_done, stay available: the orchestrator either sends you a follow-up task or stops you.'
  ]
  return [
    `${CONTRACT_MARKER} (Vertragus) ---`,
    whoLine(agentName, role),
    'You report to an orchestrator agent through MCP tools. Follow these rules for every task:',
    ...numbered(rules),
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
function buildSentinelContract({ agentName, role, approvals }: TaskContractInput): string {
  const rules = [
    'Do the work yourself. Read the repository, change the files, run the checks.',
    'When the task is finished, print one DONE report line of at most 700 characters. Build the start marker by writing `@@VERT` immediately followed by `RAGUS:DONE@@` (no space, no other characters between them). Then print compact JSON like {"summary":"what you changed and verified","status":"success"} — status may be success, blocked, or failed; omit status to mean success. Then terminate by writing `@@` immediately followed by `END@@`. Never write the joined start marker anywhere except in an actual report line.',
    'If you need a decision, a permission, an interface, or information you cannot obtain yourself, print one ASK report line the same way: build the start marker by writing `@@VERT` immediately followed by `RAGUS:ASK@@`, then compact JSON {"question":"…"}, then `@@` immediately followed by `END@@`. Wait for the orchestrator to type an answer into your terminal. Do not guess, do not pick a random option, and do not idle.',
    ...(approvals === 'ask-orchestrator'
      ? [
          'Before an action that is hard to undo or that reaches beyond your worktree — deleting files outside it, installing software system-wide, pushing branches, or changing state on an external service — print one ASK report line as taught above and wait for the typed approval. Ordinary work inside your worktree needs no approval.'
        ]
      : []),
    'If you already asked and are still waiting, do not print a second ASK. Keep waiting for the typed answer; do not rephrase and do not open a second question.',
    'On real milestones only (not a heartbeat), print one PROGRESS line: build the start marker by writing `@@VERT` immediately followed by `RAGUS:PROGRESS@@`, then compact JSON {"note":"…"}, then `@@` immediately followed by `END@@`.',
    'Never stop working silently and never end your turn without either a DONE report line or an open ASK waiting for an answer.',
    'After a DONE report line, stay available: the orchestrator either sends you a follow-up task or stops you.'
  ]
  return [
    `${CONTRACT_MARKER} (Vertragus) ---`,
    whoLine(agentName, role),
    'You report to an orchestrator by printing sentinel lines on your terminal (not MCP tools). Follow these rules for every task:',
    ...numbered(rules),
    '--- End of contract ---'
  ].join('\n')
}
