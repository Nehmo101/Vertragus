import type {
  ExecutionPlan,
  ExecutionPlanTask,
  PlanValidationIssue,
  ResolvedExecutionPlan
} from '@shared/orchestrator'

export const MAX_PLAN_TASKS = 24
const MAX_GOAL_LENGTH = 500
const MAX_TITLE_LENGTH = 160
const MAX_ROLE_LENGTH = 64
const MAX_PROMPT_LENGTH = 40_000
const MAX_CONFLICT_KEYS = 16
const MAX_EXPECTED_FILES = 64
const SHARED_HOTSPOT = /^(?:src\/shared\/|src\/main\/ipc\/|src\/preload\/|src\/shared\/profile\.ts$|src\/renderer\/src\/(?:styles|cozy-organic)\.css$)/i
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  if (!clean || clean.length > maxLength) return undefined
  return clean
}

function stringArray(value: unknown): string[] | undefined {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function fallbackPlan(input: unknown, role: string, prompt?: string): ExecutionPlan {
  const rawGoal = isRecord(input) ? cleanString(input.goal, MAX_GOAL_LENGTH) : undefined
  const goal = rawGoal ?? 'Vertragus-Aufgabe bearbeiten'
  const safeRole = cleanString(role, MAX_ROLE_LENGTH) ?? 'worker'
  const safePrompt = cleanString(prompt, MAX_PROMPT_LENGTH) ?? goal
  return {
    version: 1,
    goal,
    maxParallel: 1,
    tasks: [
      {
        id: 'fallback',
        title: goal.slice(0, MAX_TITLE_LENGTH),
        role: safeRole,
        prompt: safePrompt,
        dependsOn: [],
        advisoryDependsOn: [],
        criticality: 'required',
        conflictKeys: ['fallback-exclusive'],
        ownership: 'feature',
        expectedFiles: []
      }
    ]
  }
}

/** True when `fromId` reaches `targetId` through hard or advisory dependencies. */
function dependsTransitively(tasks: ExecutionPlanTask[], fromId: string, targetId: string): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const queue = [fromId]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const current = byId.get(queue.shift()!)
    if (!current) continue
    for (const dependency of [...current.dependsOn, ...current.advisoryDependsOn]) {
      if (dependency === targetId) return true
      if (!seen.has(dependency)) {
        seen.add(dependency)
        queue.push(dependency)
      }
    }
  }
  return false
}

function hasCycle(tasks: ExecutionPlanTask[]): boolean {
  const allDependencies = (task: ExecutionPlanTask): string[] =>
    [...task.dependsOn, ...task.advisoryDependsOn]
  const remainingDependencies = new Map(tasks.map((task) => [task.id, allDependencies(task).length]))
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    for (const dependency of allDependencies(task)) {
      const list = dependents.get(dependency) ?? []
      list.push(task.id)
      dependents.set(dependency, list)
    }
  }

  const ready = tasks.filter((task) => allDependencies(task).length === 0).map((task) => task.id)
  let visited = 0
  while (ready.length > 0) {
    const id = ready.shift()!
    visited += 1
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (remainingDependencies.get(dependent) ?? 0) - 1
      remainingDependencies.set(dependent, remaining)
      if (remaining === 0) ready.push(dependent)
    }
  }
  return visited !== tasks.length
}

/**
 * Validate an untrusted, model-authored plan. Repairable ownership issues are
 * fixed in place and reported as non-fatal `repaired_ownership` issues; any
 * remaining issue replaces the entire proposal with one conservative task —
 * partially valid plans are never run.
 */
export function resolveExecutionPlan(
  input: unknown,
  fallbackRole = 'worker',
  fallbackPrompt?: string,
  allowedRoles?: readonly string[]
): ResolvedExecutionPlan & { rejected: boolean } {
  const issues: PlanValidationIssue[] = []
  if (!isRecord(input)) {
    issues.push({ code: 'invalid_shape', message: 'Plan must be an object.' })
    return {
      plan: fallbackPlan(input, fallbackRole, fallbackPrompt),
      usedFallback: true,
      rejected: false,
      issues
    }
  }

  const isStructuredPlan = Array.isArray(input.tasks) && input.tasks.some(isRecord)

  if (input.version !== 1) {
    issues.push({ code: 'invalid_shape', message: 'version must be 1.' })
  }
  const allowedRoleSet = allowedRoles
    ? new Set(allowedRoles.map((role) => role.trim().toLowerCase()))
    : undefined

  const goal = cleanString(input.goal, MAX_GOAL_LENGTH)
  if (!goal) issues.push({ code: 'invalid_goal', message: 'goal must be a non-empty, bounded string.' })

  const maxParallel = input.maxParallel
  if (
    typeof maxParallel !== 'number' ||
    !Number.isInteger(maxParallel) ||
    maxParallel < 1
  ) {
    issues.push({
      code: 'invalid_parallelism',
      message: 'maxParallel must be a positive integer.'
    })
  }

  const rawTasks = input.tasks
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    issues.push({ code: 'invalid_shape', message: 'tasks must contain at least one task.' })
  } else if (rawTasks.length > MAX_PLAN_TASKS) {
    issues.push({
      code: 'too_many_tasks',
      message: `A plan may contain at most ${MAX_PLAN_TASKS} tasks.`
    })
  }

  const tasks: ExecutionPlanTask[] = []
  if (Array.isArray(rawTasks) && rawTasks.length <= MAX_PLAN_TASKS) {
    rawTasks.forEach((raw, index) => {
      if (!isRecord(raw)) {
        issues.push({ code: 'invalid_task', message: `Task ${index + 1} must be an object.` })
        return
      }
      const id = cleanString(raw.id, 64)
      const title = cleanString(raw.title, MAX_TITLE_LENGTH)
      const role = cleanString(raw.role, MAX_ROLE_LENGTH)
      const prompt = cleanString(raw.prompt, MAX_PROMPT_LENGTH)
      const dependsOn = stringArray(raw.dependsOn)
      const advisoryDependsOn = stringArray(raw.advisoryDependsOn)
      const conflictKeys = stringArray(raw.conflictKeys)
      const expectedFiles = stringArray(raw.expectedFiles)
      const ownership = raw.ownership == null ? 'feature' : raw.ownership
      const criticality = raw.criticality == null ? 'required' : raw.criticality
      if (
        !id ||
        !SAFE_ID.test(id) ||
        !title ||
        !role ||
        !prompt ||
        !dependsOn ||
        !advisoryDependsOn ||
        !conflictKeys ||
        !expectedFiles ||
        (ownership !== 'feature' && ownership !== 'integrator') ||
        (criticality !== 'required' && criticality !== 'advisory') ||
        dependsOn.length + advisoryDependsOn.length > MAX_PLAN_TASKS ||
        (allowedRoleSet != null && !allowedRoleSet.has(role.toLowerCase())) ||
        conflictKeys.length > MAX_CONFLICT_KEYS ||
        expectedFiles.length > MAX_EXPECTED_FILES ||
        dependsOn.includes(id) ||
        advisoryDependsOn.includes(id) ||
        advisoryDependsOn.some((dependency) => dependsOn.includes(dependency))
      ) {
        issues.push({
          code: 'invalid_task',
          message: `Task ${id ?? index + 1} has invalid fields.`,
          taskId: id
        })
        return
      }
      tasks.push({
        id,
        title,
        role,
        prompt,
        dependsOn,
        advisoryDependsOn,
        criticality,
        conflictKeys: [...new Set([
          ...conflictKeys.map((key) => key.toLowerCase()),
          ...(ownership === 'integrator' ? ['shared-hotspots'] : [])
        ])],
        ownership,
        expectedFiles: expectedFiles.map((file) => file.replace(/\\/g, '/').toLowerCase())
      })
    })
  }

  // Ownership problems are repaired in place where a safe equivalent exists;
  // only unrepairable constellations still collapse the plan (see fallback below).
  const repairs: PlanValidationIssue[] = []
  const integrators = tasks.filter((task) => task.ownership === 'integrator')
  if (integrators.length > 1) {
    issues.push({ code: 'invalid_ownership', message: 'A plan may contain only one shared-file integrator.' })
  }
  const declaredSharedFiles = tasks.flatMap((task) =>
    task.expectedFiles.filter((file) => SHARED_HOTSPOT.test(file)).map((file) => ({ task, file }))
  )
  for (const { task, file } of declaredSharedFiles) {
    if (task.ownership !== 'integrator') {
      // The protected property is "no concurrent writes to shared hotspots".
      // Serializing the writer via the integrator conflict key preserves it
      // without discarding the whole plan.
      if (!task.conflictKeys.includes('shared-hotspots')) {
        task.conflictKeys = [...task.conflictKeys, 'shared-hotspots']
      }
      repairs.push({
        code: 'repaired_ownership',
        message: 'Shared hotspot ' + file + ' is written by task ' + task.id + '; the task was serialized via the shared-hotspots conflict key.',
        taskId: task.id
      })
    }
  }
  const integrator = integrators.length === 1 ? integrators[0] : undefined
  if (integrator) {
    const integrationDependencies = new Set([
      ...integrator.dependsOn,
      ...integrator.advisoryDependsOn
    ])
    const missingDependencies = tasks.filter(
      (task) =>
        task.id !== integrator.id &&
        !integrationDependencies.has(task.id)
    )
    if (missingDependencies.length > 0) {
      // Advisory edges keep the integrator waiting for every feature task —
      // required AND advisory — without cascading a single feature failure into
      // an integrator stop. Advisory feature tasks were previously skipped, so a
      // plan whose integrator needed one collapsed to fallback (retro cluster).
      // A task that already depends on the integrator cannot be repaired this
      // way (the new edge would close a cycle).
      const repairable = missingDependencies.filter(
        (task) => !dependsTransitively(tasks, task.id, integrator.id)
      )
      const unrepairable = missingDependencies.filter((task) => !repairable.includes(task))
      const repairedEdgeCount =
        integrator.dependsOn.length + integrator.advisoryDependsOn.length + repairable.length
      if (repairable.length > 0 && repairedEdgeCount <= MAX_PLAN_TASKS) {
        integrator.advisoryDependsOn = [
          ...integrator.advisoryDependsOn,
          ...repairable.map((task) => task.id)
        ]
        repairs.push({
          code: 'repaired_ownership',
          message: 'The integrator was missing dependencies on task(s) ' +
            repairable.map((task) => task.id).join(', ') +
            '; advisory dependencies were added automatically.',
          taskId: integrator.id
        })
      }
      // Only a *required* task that cannot be repaired (or a required task lost
      // to the edge budget) collapses the plan. A non-repairable advisory task
      // must not — advisory ordering is optional by definition.
      const requiredUnrepairable = unrepairable.some((task) => task.criticality === 'required')
      const requiredMissing = missingDependencies.some((task) => task.criticality === 'required')
      if (requiredUnrepairable || (repairedEdgeCount > MAX_PLAN_TASKS && requiredMissing)) {
        issues.push({ code: 'invalid_ownership', message: 'The integrator must depend on every required feature task.', taskId: integrator.id })
      }
    }
  }

  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) {
      issues.push({
        code: 'duplicate_task_id',
        message: `Task id "${task.id}" occurs more than once.`,
        taskId: task.id
      })
    }
    ids.add(task.id)
  }
  for (const task of tasks) {
    for (const dependency of [...task.dependsOn, ...task.advisoryDependsOn]) {
      if (!ids.has(dependency)) {
        issues.push({
          code: 'unknown_dependency',
          message: `Task "${task.id}" depends on unknown task "${dependency}".`,
          taskId: task.id
        })
      }
    }
  }
  if (tasks.length > 0 && !issues.some((issue) => issue.code === 'unknown_dependency') && hasCycle(tasks)) {
    issues.push({ code: 'dependency_cycle', message: 'Task dependencies must form an acyclic graph.' })
  }

  if (issues.length > 0 || !goal || typeof maxParallel !== 'number') {
    return {
      plan: fallbackPlan(input, fallbackRole, fallbackPrompt),
      usedFallback: true,
      rejected: isStructuredPlan,
      issues: [...issues, ...repairs]
    }
  }
  return {
    plan: { version: 1, goal, maxParallel, tasks },
    usedFallback: false,
    rejected: false,
    issues: repairs
  }
}
