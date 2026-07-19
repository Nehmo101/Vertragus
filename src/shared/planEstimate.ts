/**
 * Deterministic delegation estimate derived from an execution plan.
 *
 * The orchestrator's "does this even need a subagent team?" decision is soft
 * prose in the system prompt today. This module turns the plan STRUCTURE into a
 * reliable, side-effect-free signal — how many tasks could genuinely run at the
 * same time — so the engine can hand the orchestrator concrete feedback on its
 * own plan before any process starts, and the retro can score the estimate
 * against what actually happened.
 *
 * Pure data + plan types only; no Node.js imports so every process can use it.
 */
import type { ExecutionPlan, ExecutionPlanTask } from './orchestrator'

export type DelegationRecommendation = 'solo' | 'delegate'

export type EstimateConfidence = 'low' | 'medium' | 'high'

/**
 * The orchestrator's OWN pre-plan prediction, recorded via the
 * estimate_delegation tool before execute_plan. Kept on the same
 * `recommendation` axis as {@link PlanDelegationEstimate} so the retro can
 * calibrate the model's judgement against the structural anchor and the real
 * outcome.
 */
export interface OrchestratorDelegationEstimate {
  recommendation: DelegationRecommendation
  /** How many tasks the orchestrator expects to run at once (1 = solo). */
  expectedParallelTasks: number
  confidence: EstimateConfidence
  rationale: string
  createdAt: number
}

export interface PlanDelegationEstimate {
  /** solo = one agent suffices; delegate = a parallel team buys something. */
  recommendation: DelegationRecommendation
  taskCount: number
  requiredTaskCount: number
  /** Largest dependency layer — tasks that could structurally start together. */
  parallelWidth: number
  /** parallelWidth after collapsing tasks that share a conflictKey (never co-run). */
  effectiveParallelWidth: number
  hasIntegrator: boolean
  /** maxParallel the plan itself declared. */
  declaredMaxParallel: number
  /** Structure allows real parallelism but the plan serializes it (maxParallel too low). */
  underParallelized: boolean
  /** Concise German rationale for the recommendation. */
  reason: string
}

/** All dependency edges (hard + advisory) both delay a task's start. */
function allDependencies(task: ExecutionPlanTask): string[] {
  return [...(task.dependsOn ?? []), ...(task.advisoryDependsOn ?? [])]
}

/**
 * Group a plan into dependency layers (Kahn layering): every task in a layer
 * has all its dependencies satisfied by earlier layers, so a layer is the set
 * of tasks that could start at the same moment. Unknown dependencies are
 * ignored (the plan validator handles them); a cycle stops the layering early.
 */
function dependencyLayers(tasks: readonly ExecutionPlanTask[]): ExecutionPlanTask[][] {
  const ids = new Set(tasks.map((task) => task.id))
  const done = new Set<string>()
  const layers: ExecutionPlanTask[][] = []
  while (done.size < tasks.length) {
    const ready = tasks.filter(
      (task) =>
        !done.has(task.id) &&
        allDependencies(task)
          .filter((dependency) => ids.has(dependency))
          .every((dependency) => done.has(dependency))
    )
    if (ready.length === 0) break // cycle or self-reference: bail out of layering
    layers.push(ready)
    for (const task of ready) done.add(task.id)
  }
  return layers
}

/**
 * How many tasks in one layer can truly run at once: tasks with no conflictKey
 * are each independent, while any tasks sharing a conflictKey (transitively)
 * collapse into a single concurrency slot because they may touch the same files.
 */
function effectiveConcurrency(layer: readonly ExecutionPlanTask[]): number {
  const parent = new Map<string, string>()
  const find = (node: string): string => {
    let root = node
    while (parent.get(root) !== root) root = parent.get(root)!
    let cursor = node
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const ensure = (node: string): void => {
    if (!parent.has(node)) parent.set(node, node)
  }
  const union = (a: string, b: string): void => {
    ensure(a)
    ensure(b)
    parent.set(find(a), find(b))
  }

  let keyless = 0
  for (const task of layer) {
    const keys = task.conflictKeys ?? []
    if (keys.length === 0) {
      keyless += 1
      continue
    }
    ensure(keys[0])
    for (let index = 1; index < keys.length; index += 1) union(keys[0], keys[index])
  }
  const components = new Set<string>()
  for (const task of layer) {
    const keys = task.conflictKeys ?? []
    if (keys.length > 0) components.add(find(keys[0]))
  }
  return keyless + components.size
}

/**
 * Estimate whether a plan genuinely needs a delegated subagent team. The
 * concrete benefit of subagents is concurrency: when nothing in the plan can
 * run in parallel, a single agent doing the work sequentially is cheaper and
 * simpler, so the recommendation is `solo`. When two or more tasks can run at
 * once, `delegate`. Under-parallelization (structure allows parallelism but
 * maxParallel serializes it) is flagged rather than hidden.
 */
export function estimatePlanDelegation(plan: ExecutionPlan): PlanDelegationEstimate {
  const tasks = plan.tasks ?? []
  const taskCount = tasks.length
  const requiredTaskCount = tasks.filter((task) => task.criticality !== 'advisory').length
  const hasIntegrator = tasks.some((task) => task.ownership === 'integrator')
  const declaredMaxParallel =
    Number.isInteger(plan.maxParallel) && plan.maxParallel > 0 ? plan.maxParallel : 1

  const layers = dependencyLayers(tasks)
  const parallelWidth = layers.reduce((max, layer) => Math.max(max, layer.length), 0)
  const effectiveParallelWidth = layers.reduce(
    (max, layer) => Math.max(max, effectiveConcurrency(layer)),
    0
  )

  const recommendation: DelegationRecommendation =
    effectiveParallelWidth >= 2 ? 'delegate' : 'solo'
  const underParallelized =
    recommendation === 'delegate' && declaredMaxParallel < effectiveParallelWidth

  return {
    recommendation,
    taskCount,
    requiredTaskCount,
    parallelWidth,
    effectiveParallelWidth,
    hasIntegrator,
    declaredMaxParallel,
    underParallelized,
    reason: buildReason({
      recommendation,
      taskCount,
      effectiveParallelWidth,
      hasIntegrator,
      declaredMaxParallel,
      underParallelized
    })
  }
}

function buildReason(input: {
  recommendation: DelegationRecommendation
  taskCount: number
  effectiveParallelWidth: number
  hasIntegrator: boolean
  declaredMaxParallel: number
  underParallelized: boolean
}): string {
  if (input.recommendation === 'solo') {
    if (input.taskCount <= 1) {
      return 'Nur ein Task — kein Subagent-Team nötig; ein einzelner Agent genügt.'
    }
    return (
      `Ein einzelner Agent genügt: ${input.taskCount} Task(s), aber keine echt parallelen ` +
      'Arbeitsstränge (max. gleichzeitig ausführbar: 1). Ein Team bringt keinen Parallelitätsvorteil.'
    )
  }
  const funnel = input.hasIntegrator ? ' (mit einem Integrator als Trichter)' : ''
  const base =
    `Delegation lohnt: bis zu ${input.effectiveParallelWidth} Tasks können gleichzeitig laufen${funnel}.`
  if (input.underParallelized) {
    return (
      `${base} Achtung: maxParallel=${input.declaredMaxParallel} serialisiert diese ` +
      `${input.effectiveParallelWidth} unabhängigen Stränge unnötig — erhöhe maxParallel auf ${input.effectiveParallelWidth}.`
    )
  }
  return base
}
