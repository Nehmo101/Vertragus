import type {
  ExecutionPlan,
  ExecutionPlanTask,
  PlanValidationIssue,
  ResolvedExecutionPlan
} from '@shared/orchestrator'

export const MAX_PLAN_TASKS = 24
export const MAX_PLAN_PARALLEL = 8
const MAX_GOAL_LENGTH = 500
const MAX_TITLE_LENGTH = 160
const MAX_ROLE_LENGTH = 64
const MAX_PROMPT_LENGTH = 40_000
const MAX_CONFLICT_KEYS = 16
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
  const goal = rawGoal ?? 'Orca-Aufgabe bearbeiten'
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
        conflictKeys: ['fallback-exclusive']
      }
    ]
  }
}

function hasCycle(tasks: ExecutionPlanTask[]): boolean {
  const remainingDependencies = new Map(tasks.map((task) => [task.id, task.dependsOn.length]))
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      const list = dependents.get(dependency) ?? []
      list.push(task.id)
      dependents.set(dependency, list)
    }
  }

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id)
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
 * Validate an untrusted, model-authored plan. Any issue replaces the entire
 * proposal with one conservative task; partially valid plans are never run.
 */
export function resolveExecutionPlan(
  input: unknown,
  fallbackRole = 'worker',
  fallbackPrompt?: string,
  allowedRoles?: readonly string[]
): ResolvedExecutionPlan {
  const issues: PlanValidationIssue[] = []
  if (!isRecord(input)) {
    issues.push({ code: 'invalid_shape', message: 'Plan must be an object.' })
    return { plan: fallbackPlan(input, fallbackRole, fallbackPrompt), usedFallback: true, issues }
  }

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
    maxParallel < 1 ||
    maxParallel > MAX_PLAN_PARALLEL
  ) {
    issues.push({
      code: 'invalid_parallelism',
      message: `maxParallel must be an integer from 1 to ${MAX_PLAN_PARALLEL}.`
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
      const conflictKeys = stringArray(raw.conflictKeys)
      if (
        !id ||
        !SAFE_ID.test(id) ||
        !title ||
        !role ||
        !prompt ||
        !dependsOn ||
        !conflictKeys ||
        dependsOn.length > MAX_PLAN_TASKS ||
        (allowedRoleSet != null && !allowedRoleSet.has(role.toLowerCase())) ||
        conflictKeys.length > MAX_CONFLICT_KEYS ||
        dependsOn.includes(id)
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
        conflictKeys: conflictKeys.map((key) => key.toLowerCase())
      })
    })
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
    for (const dependency of task.dependsOn) {
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
      issues
    }
  }
  return {
    plan: { version: 1, goal, maxParallel, tasks },
    usedFallback: false,
    issues: []
  }
}
