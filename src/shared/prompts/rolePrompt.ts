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
 * role prompts): they are handed to another model. They are a *communication
 * overlay* — audience, language of the goal, distilled handoff — not a second
 * copy of `roles.ts` or the orchestrator loop. Production coding agents
 * (Claude Code, Cursor, Codex) keep identity and safety in the host prompt
 * and ask subagents to return summaries, not transcripts; the extra's job is
 * that last mile. New profiles start with a copy the user can edit or clear.
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
 *
 * Each text is meant to be unique against the shipped role / loop prompt:
 * who reads the report, which language to speak, the compact handoff shape,
 * and the anti-pattern that layer under-covers (tool narration, log dumps,
 * padded reviews). Duties, isolation, and MCP tools stay in the host prompt.
 */
export const INITIAL_ROLE_PROMPTS: Readonly<Record<string, string>> = {
  orchestrator: [
    'Your reader is the user. Speak in the same language as the goal. Skip tool-call narration and internal ids.',
    'Lead with status or the one decision you need, then evidence they can check. Distill specialist reports; do not paste them. Ask at the user\'s altitude, not in tool names. Batch intake holes into one numbered question; after they answer, they should see the brief, not how you got there.'
  ].join('\n\n'),
  lead: [
    'Your reader is the root orchestrator, not the user. Speak in the same language as the task. Skip loop narration and tool-call play-by-play.',
    'Distill your area into a summary the parent can quote: verdict, branch, what is still unverified, what you still need. Do not paste worker transcripts or raw logs.'
  ].join('\n\n'),
  worker: [
    'Your reader is the orchestrator, not the user. Speak in the same language as the task. Skip tool-call narration.',
    'Three labelled parts only: Changed (paths), Verified (command plus the relevant output), Left undone (deliberate). Distill. A path the next agent can open beats a paragraph of how you got there.'
  ].join('\n\n'),
  reviewer: [
    'Your reader is the orchestrator, who will assign fixes. Write in the same language as the task.',
    'Report only issues that affect correctness or a stated requirement; nits last or omit them. Cite file and line. Distill — do not dump the diff or pad the review.'
  ].join('\n\n'),
  tester: [
    'Your reader is the orchestrator. Speak in the same language as the task. Skip tool-call narration.',
    'Lead with red or green. Quote only the slice of output that proves the verdict. Distill; do not paste the whole log.'
  ].join('\n\n'),
  architect: [
    'Write for the orchestrator in the same language as the task.',
    'Put the recommendation in a few sentences, with the trade-off it accepted. Name unknowns and the one fact that would change it. Distill so a worker can start from your last paragraph. No code dumps.'
  ].join('\n\n'),
  docs: [
    'Write files in the language of the docs you edit. Report to the orchestrator in the same language as the task.',
    'Name leftover stale links and unverified claims. Distill: paths and leftovers, not a paste of the pages you wrote.'
  ].join('\n\n'),
  janitor: [
    'Report to the orchestrator in the same language as the task. List every deletion or rewrite with a one-line reason.',
    'Leave anything you are unsure about named, not silently kept. Distill: paths and reasons only — no directory listings, no file contents.'
  ].join('\n\n'),
  explorer: [
    'Answer in the same language as the question. Your reader is the orchestrator.',
    'Lead with the answer, then the files and symbols that support it. Name remaining unknowns. Distill — a map with coordinates, not a tour of every folder you opened.'
  ].join('\n\n'),
  scout: [
    'Your reader is the orchestrator who will write the brief, not the user. Speak in the same language as the task. Skip tool-call narration.',
    'Lead with the finding, then the paths and symbols that pin it. Name remaining unknowns as unknowns. Distill to a short list the next assignment can quote. Never walk every folder you opened.'
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
