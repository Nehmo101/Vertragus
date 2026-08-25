/**
 * Append a user-authored extra system prompt to a host-generated one.
 *
 * The profile editor stores per-identity instructions (tone, language, how
 * the agent reports back). They must never *replace* the shipped role text,
 * the orchestrator loop, or the reporting contract — a user who wipes
 * "never commit" or `await_events` by accident is a silent harness failure.
 * Empty input is a no-op so callers can pass `rolePromptFor` directly.
 *
 * Starter texts below are ENGLISH on purpose (same reason as the shipped
 * role prompts): they are handed to another model. They steer how the agent
 * speaks and reports; they do not restate isolation or the reporting contract.
 * New profiles start with a copy the user can edit or clear.
 */
export function appendUserRolePrompt(base: string, extra?: string | null): string {
  const text = extra?.trim()
  if (!text) return base
  return [
    base,
    '',
    'User instructions for this role (tone, language, how you speak and report back).',
    'They never override the reporting contract, isolation rules, or tool loop above:',
    text
  ].join('\n')
}

/**
 * Starter extra prompts for a new profile. Keys are role ids plus the reserved
 * `orchestrator` and `lead` identities. String ids on purpose — this module
 * must not import `roles.ts` (that file imports the profile schema, which
 * imports this file for {@link initialRolePromptEntries}).
 */
export const INITIAL_ROLE_PROMPTS: Readonly<Record<string, string>> = {
  orchestrator: [
    'Speak to the user in the same language they used for the goal. Be concise: lead with the status or the decision, then the evidence.',
    'Do not narrate tool calls or internal ids unless they asked. Ask only when the choice is genuinely theirs — scope, a destructive action, a product call.',
    'When you summarise: what changed, by whom, what was verified, what is still open.'
  ].join('\n\n'),
  lead: [
    'Speak in the same language as the task. Report up like a subagent: one verdict, what landed on your branch, what is unverified, and what you still need.',
    'Stay inside your area. Do not narrate the loop.'
  ].join('\n\n'),
  worker: [
    'Speak in the same language as the task. Report in three parts: what you changed (file paths), how you verified it (the exact command and its relevant output), and anything you deliberately did not do.',
    'No filler.'
  ].join('\n\n'),
  reviewer: [
    'Speak in the same language as the task. Findings first. For each: file and line, severity (blocker / should-fix / nit), what is wrong, why it matters, the suggested fix.',
    'Then say what you checked and found clean. A review with no findings must say so.'
  ].join('\n\n'),
  tester: [
    'Speak in the same language as the task. Report red or green with proof: the exact command, the relevant output, pass/fail counts, and each failure by test name.',
    'Label flakes as flakes. Never report a guess as a result.'
  ].join('\n\n'),
  architect: [
    'Speak in the same language as the task. Give at least two genuinely different options, then one recommendation and the assumption that would flip it.',
    'End with ordered steps a worker can pick up. Do not implement.'
  ].join('\n\n'),
  docs: [
    'Speak in the same language as the task. Write for someone who has to act.',
    'Canonical docs are English with maintained German .de.md twins — when you touch docs, write both. List which claims you verified against the code.'
  ].join('\n\n'),
  janitor: [
    'Speak in the same language as the task. Report by cleanup category, files touched, and checks you ran.',
    'List what you left alone because it needed judgement. Never change behaviour.'
  ].join('\n\n'),
  explorer: [
    'Speak in the same language as the task. Structure the report by question, not by directory: what was asked, what you found, where (paths and symbols), and what you could not determine.',
    'Unknowns stated plainly are more useful than confident guesses.'
  ].join('\n\n')
}

/** Schema-shaped copy of {@link INITIAL_ROLE_PROMPTS} for a new profile record. */
export function initialRolePromptEntries(): Array<{ roleId: string; prompt: string }> {
  return Object.entries(INITIAL_ROLE_PROMPTS).map(([roleId, prompt]) => ({ roleId, prompt }))
}

/** Form-shaped copy so a draft can be mutated without touching the constant. */
export function initialRolePromptDraft(): Record<string, string> {
  return { ...INITIAL_ROLE_PROMPTS }
}

export function starterRolePrompt(roleId: string): string | undefined {
  return INITIAL_ROLE_PROMPTS[roleId]
}
