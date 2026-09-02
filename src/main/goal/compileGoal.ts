/**
 * Compile a short Play goal into a run contract.
 *
 * Host-side, always. The orchestrator does not write this file — it follows it.
 * `off` is the escape hatch (raw goal, today's behaviour). `cheap` / `scout`
 * are repo probes, not a subagent; spawning a compile-phase scout is a
 * follow-up, not this track.
 */
import { buildRunContract, type BriefJson } from '@shared/goal/brief'
import {
  classifyRecipe,
  type GoalCompileMode,
  type RecipeId
} from '@shared/goal/recipes'
import type { QuestionMode } from '@shared/schema/profile'
import { probeRepo, type ProbeDepth } from './probeRepo'

export interface CompileGoalInput {
  goal: string
  repoPath: string
  mode: GoalCompileMode
  questionMode: QuestionMode
  /** Playbook override — when the clicked template named a recipe. */
  recipe?: RecipeId
  /** Relative path of brief.md inside the repo, once known. */
  briefPath?: string
}

export interface CompiledGoal {
  mode: GoalCompileMode
  recipe: RecipeId
  /** What the CLI is seeded with. */
  firstTurn: string
  /** One line for the workspace card. Absent when mode is off. */
  preview?: string
  markdown?: string
  json?: BriefJson
  assumptions: string[]
}

const EMPTY_FACTS = {
  docs: [] as string[],
  scripts: [] as string[],
  modules: [] as Array<{ id: string; path: string }>,
  invariants: [] as string[],
  showcases: [] as string[]
}

/**
 * Compile. Never throws to the start path — a probe failure falls back to a
 * contract with empty facts, not to the raw goal (the recipe still applies).
 * Only `off` returns the raw goal as the first turn.
 */
export async function compileGoal(input: CompileGoalInput): Promise<CompiledGoal> {
  const goal = input.goal.trim()
  if (!goal || input.mode === 'off') {
    return {
      mode: input.mode,
      recipe: input.recipe ?? classifyRecipe(goal),
      firstTurn: goal,
      assumptions: []
    }
  }

  const recipe = input.recipe ?? classifyRecipe(goal)
  const depth: ProbeDepth = input.mode === 'scout' ? 'scout' : 'cheap'
  let facts = EMPTY_FACTS
  try {
    facts = await probeRepo(input.repoPath, depth)
  } catch {
    facts = EMPTY_FACTS
  }

  const built = buildRunContract({
    goal,
    recipe,
    repoPath: input.repoPath,
    questionMode: input.questionMode,
    facts,
    ...(input.briefPath ? { briefPath: input.briefPath } : {})
  })

  return {
    mode: input.mode,
    recipe,
    firstTurn: built.firstTurn,
    preview: built.preview,
    markdown: built.markdown,
    json: built.json,
    assumptions: built.assumptions
  }
}
