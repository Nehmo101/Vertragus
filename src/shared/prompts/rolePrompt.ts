/**
 * Append a user-authored extra system prompt to a host-generated one.
 *
 * The profile editor stores per-identity instructions (tone, language, how
 * the agent reports back). They must never *replace* the shipped role text,
 * the orchestrator loop, or the reporting contract — a user who wipes
 * "never commit" or `await_events` by accident is a silent harness failure.
 * Empty input is a no-op so callers can pass `rolePromptFor` directly.
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
