/**
 * Goal-compile recipes — the host picks one from the user's short Play text.
 *
 * Model-facing English on purpose (same reason as the task contract). The
 * user goal stays verbatim in whatever language they typed.
 */
export const GOAL_COMPILE_MODES = ['off', 'cheap', 'scout'] as const
export type GoalCompileMode = (typeof GOAL_COMPILE_MODES)[number]

export const RECIPE_IDS = [
  'presence-gauntlet',
  'fix-and-verify',
  'ship-in-place',
  'scout-then-brief',
  'docs-only',
  'invariant-first'
] as const
export type RecipeId = (typeof RECIPE_IDS)[number]

const FOLD_MAP: Record<string, string> = {
  ä: 'a',
  ö: 'o',
  ü: 'u',
  ß: 'ss',
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ú: 'u'
}

/** Lowercase, umlauts folded — classification is language-agnostic enough. */
export function normalizeGoal(goal: string): string {
  return goal
    .trim()
    .toLowerCase()
    .replace(/[äöüßáéíóú]/g, (ch) => FOLD_MAP[ch] ?? ch)
}

function has(haystack: string, pattern: RegExp): boolean {
  return pattern.test(haystack)
}

/**
 * Pick the recipe. Explicit "do not build" wins; security wording beats a
 * generic "fix"; visual AAA beats a generic "build". Unknown text becomes
 * ship-in-place — never a pass-through of the raw sentence as the contract.
 */
/**
 * Markdown bullets that read as a rule. Shared so main-process probe code
 * does not carry German literals (mainMessagesDrift).
 */
export function looksLikeInvariant(body: string): boolean {
  const folded = normalizeGoal(body)
  return (
    /\b(never|must not|do not|don't|dont|shall not)\b/i.test(body) ||
    /\b(niemals|darf nicht|muss nicht)\b/.test(folded) ||
    /\bkein(e|en|em|er)?\b/.test(folded)
  )
}

export function classifyRecipe(goal: string): RecipeId {
  const text = normalizeGoal(goal)
  if (!text) return 'ship-in-place'
  if (
    has(
      text,
      /\b(plane|planen|research|rfc|how should|wie sollte|noch nicht bauen|don't build|dont build|do not build|nicht bauen)\b/
    )
  ) {
    return 'scout-then-brief'
  }
  if (
    has(
      text,
      /\b(security|authz|authn|dm_only|ssrf|csrf|privacy|geheim|zugang|owner_private)\b/
    )
  ) {
    return 'invariant-first'
  }
  if (
    has(
      text,
      /\b(aaa|ghibli|pbr|look|visuell|visual|schon|schoen|ux|art direction|painterly|screenshot|polish|anmutung|presence)\b/
    )
  ) {
    return 'presence-gauntlet'
  }
  if (
    has(text, /\b(changelog|handbook|dokumentation|readme|skill\.md)\b/) ||
    (has(text, /\bdocs\b/) && !has(text, /\b(fix|bug|fail|rot|red)\b/))
  ) {
    return 'docs-only'
  }
  if (
    has(
      text,
      /\b(bug|flake|crash|hotfix|reparier|failing|fehler|regress)\b/
    ) ||
    has(text, /\bci\b/) ||
    has(text, /\b(ist rot|is red|goes red)\b/)
  ) {
    return 'fix-and-verify'
  }
  return 'ship-in-place'
}

/** One-line labels for the card preview — English, short. */
export const RECIPE_LABEL: Record<RecipeId, string> = {
  'presence-gauntlet': 'presence-gauntlet',
  'fix-and-verify': 'fix-and-verify',
  'ship-in-place': 'ship-in-place',
  'scout-then-brief': 'scout-then-brief',
  'docs-only': 'docs-only',
  'invariant-first': 'invariant-first'
}
