/**
 * D4: how far a subagent may act without a human.
 *
 * - `yolo` — the CLI runs with its skip-permissions flags; the agent acts.
 * - `ask-user` — no yolo flags; the CLI's own permission prompt appears in the
 *   agent's terminal and waits for the user. Hard enforcement, needs a human
 *   at the desktop.
 * - `ask-orchestrator` — the CLI still runs with yolo flags (nobody sits at a
 *   subagent terminal), but the task contract adds a rule to clear risky
 *   actions through `ask_orchestrator` first. Soft, prompt-level enforcement —
 *   the honest trade is written out in the README's threat model.
 *
 * Lives in shared/ because the Electron-free workspace and MCP layers need the
 * type without touching the settings store (which imports Electron).
 */
export const AGENT_POLICIES = ['yolo', 'ask-user', 'ask-orchestrator'] as const

export type AgentPolicy = (typeof AGENT_POLICIES)[number]
