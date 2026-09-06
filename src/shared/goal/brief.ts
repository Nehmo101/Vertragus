/**
 * Assemble the run contract the orchestrator receives as its first user turn.
 *
 * The card keeps the user's raw goal. This file is what the CLI is told.
 * English on purpose — model-facing, same as the task contract.
 */
import type { QuestionMode } from '../schema/profile'
import { RECIPE_LABEL, type RecipeId } from './recipes'

export interface RepoFacts {
  product?: string
  docs: string[]
  scripts: string[]
  modules: Array<{ id: string; path: string }>
  invariants: string[]
  showcases: string[]
}

export interface BuildContractInput {
  goal: string
  recipe: RecipeId
  repoPath: string
  questionMode: QuestionMode
  facts: RepoFacts
  /** Relative path of brief.md once the journal wrote it. */
  briefPath?: string
}

export interface BriefJson {
  recipe: RecipeId
  goal: string
  preview: string
  assumptions: string[]
  modules: Array<{ id: string; path: string }>
  invariants: string[]
  verify: { tests: string[]; showcases: string[] }
}

export interface BuiltContract {
  markdown: string
  firstTurn: string
  preview: string
  json: BriefJson
  assumptions: string[]
}

const HOW_TO_WORK: Record<RecipeId, string[]> = {
  'presence-gauntlet': [
    'Architecture first: freeze the system that exists. Write or update ARCHITECTURE.md for the named subsystem before look changes. Do not invent a second app, bundler, or visual language.',
    'Verification before claims: use this repo’s screenshot / visual / browser tools. “Tests passed” is not a look claim. Never treat a software rasterizer as visual evidence.',
    'Fan out by existing folders. One builder owns one folder. Core seams go through one integrator.',
    'A separate critic scores 0–10 against THIS repo’s references (quality contract, art briefs, existing showcases). Pass = ≥8.5 and zero errors, up to 4 rounds. Do not inflate scores.',
    'Persist scores and open issues so the next round resumes from the weakest module.'
  ],
  'fix-and-verify': [
    'Reproduce first. Quote the failing command and the slice of output that proves it.',
    'Smallest diff that fixes that failure. No refactor, no neighbour modules, no drive-by cleanup.',
    'Re-run the same command. The repo gate that already exists must stay green.',
    'Do not expand scope. If you find a second bug, name it as leftover — do not fix it in this run unless it blocks the repro.'
  ],
  'ship-in-place': [
    'Work inside existing package / app / folder boundaries. Do not start a parallel system.',
    'Tests that already cover the area run before you call the work done. Add a test when the behaviour is new.',
    'Core shared files (store, barrels, auth, CSP, the iframe bridge, the harness loop) change only when the feature cannot land without them, and then as a dedicated seam — not as a side edit.',
    'Non-goals: rewrite, extra framework, extra bundler, extra orchestration product.'
  ],
  'scout-then-brief': [
    'Do not write product code. Do not open a feature branch of implementation.',
    'Read the code. Produce one artefact (markdown) the user can act on: current system, options, recommendation, open questions.',
    'Stop when the artefact is written. Implementation is a later Play.'
  ],
  'docs-only': [
    'Edit documentation, skills, and changelog twins. No silent code changes.',
    'English-canonical docs keep their German twin in the same change when this repo requires twins.',
    'Do not invent APIs or behaviour the code does not have.'
  ],
  'invariant-first': [
    'The kill-invariants of this repo go first. Quote them from AGENTS.md / security docs before touching code.',
    'Add or extend the test that would have caught the leak / bypass. The fix without that test is not done.',
    'No “while we are here” UX or refactors. Privacy and authz diffs stay small and reviewable.'
  ]
}

function bullet(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n')
}

function assumptionsOf(input: BuildContractInput): string[] {
  const out = [
    'Work in the existing repository. Do not scaffold a replacement.',
    'Routine product choices are yours; do not run an intake round.',
    `Question mode is ${input.questionMode}: ask the human only when that mode requires it.`
  ]
  if (input.facts.product) out.push(`Treat the product as: ${input.facts.product}.`)
  return out
}

function previewOf(input: BuildContractInput): string {
  const recipe = RECIPE_LABEL[input.recipe]
  const moduleHint =
    input.facts.modules[0]?.path ??
    (input.facts.docs[0] ? input.facts.docs[0] : 'repo')
  const gate = input.facts.scripts[0] ?? 'existing gate'
  return `Compiled · ${recipe} · ${moduleHint} · ${gate}`
}

function verifyBlock(facts: RepoFacts): string {
  const tests = facts.scripts.length > 0 ? facts.scripts.join(', ') : '(none found — use the repo’s existing test command)'
  const shows =
    facts.showcases.length > 0 ? facts.showcases.join(', ') : '(none listed)'
  return `Tests / gates: ${tests}\nShowcases: ${shows}`
}

function modulesBlock(facts: RepoFacts): string {
  if (facts.modules.length === 0) return '(probe found no named modules — stay inside the paths the goal names)'
  return facts.modules.map((module) => `- ${module.id}: ${module.path}`).join('\n')
}

function invariantsBlock(facts: RepoFacts): string {
  if (facts.invariants.length === 0) {
    return '- Do not break existing tests, authz, or the public API of modules you did not name.'
  }
  return bullet(facts.invariants)
}

/**
 * Build markdown + a first-turn pointer small enough to seed through a PTY.
 * The markdown is the durable copy; the first turn always includes the raw
 * goal so a missing brief.md still carries intent.
 */
export function buildRunContract(input: BuildContractInput): BuiltContract {
  const assumptions = assumptionsOf(input)
  const preview = previewOf(input)
  const json: BriefJson = {
    recipe: input.recipe,
    goal: input.goal,
    preview,
    assumptions,
    modules: input.facts.modules,
    invariants: input.facts.invariants,
    verify: { tests: input.facts.scripts, showcases: input.facts.showcases }
  }

  const markdown = [
    '# Run contract',
    '',
    'Host-compiled from the Play field. The user typed the goal; this file is the contract.',
    '',
    '## User goal (verbatim)',
    '',
    input.goal,
    '',
    `## Recipe`,
    '',
    input.recipe,
    '',
    '## How to work',
    '',
    bullet(HOW_TO_WORK[input.recipe]),
    '',
    '## Repo facts (probe — verify against the code)',
    '',
    input.facts.product ? `Product: ${input.facts.product}` : 'Product: (unspecified)',
    '',
    'Modules:',
    modulesBlock(input.facts),
    '',
    'Invariants:',
    invariantsBlock(input.facts),
    '',
    verifyBlock(input.facts),
    '',
    '## Assumptions',
    '',
    bullet(assumptions),
    '',
    '## Rules',
    '',
    '- Do not ask intake questions the goal already settles.',
    '- Do not inflate status. Report what you verified.',
    '- Do not edit unrelated folders.',
    '- Start at First move. Keep going.',
    '',
    '## First move',
    '',
    '1. Read the files the probe named (AGENTS.md / README / the named module).',
    '2. Confirm the recipe still fits. If it does not, say so in one sentence and continue with the closer recipe — do not stop for permission.',
    '3. Begin the work. The user goal above is authoritative intent.'
  ].join('\n')

  const briefLine = input.briefPath
    ? `Follow the run contract at ${input.briefPath} (also pasted below if that file is missing).`
    : 'Follow this run contract:'

  const firstTurn = [
    briefLine,
    `User goal (verbatim): ${input.goal}`,
    `Recipe: ${input.recipe}`,
    `Preview: ${preview}`,
    `Assumptions: ${assumptions.join(' ')}`,
    '',
    'How to work:',
    ...HOW_TO_WORK[input.recipe].map((line, index) => `${index + 1}. ${line}`),
    '',
    'Start at First move. Do not ask intake questions.'
  ].join('\n')

  return { markdown, firstTurn, preview, json, assumptions }
}
