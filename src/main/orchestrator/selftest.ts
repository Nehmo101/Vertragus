/**
 * Integration self-test for the orchestration core. Enabled with
 * VERTRAGUS_MCP_SELFTEST=1. Connects a real MCP client to the running MCP
 * server and exercises the tools end-to-end, stubbing agentManager.runTask so
 * no real (paid) CLI is spawned. Logs [SELFTEST] lines and quits.
 *
 * This verifies the value path: MCP tool call -> engine -> dispatch routing ->
 * result returned to the caller, plus the DAG snapshot updates.
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { agentManager } from '@main/agents/AgentManager'
import { orchestratorEngine } from '@main/orchestrator/Engine'
import { getMcpHandle } from '@main/orchestrator/mcpHandle'
import { getOrchestratorAdapter } from '@main/orchestrator/providerAdapters'
import { Semaphore } from '@main/orchestrator/semaphore'
import {
  saveProfile,
  deleteProfile,
  getActiveProfileId,
  setActiveProfileId
} from '@main/config/store'
import type { AgentInstanceInfo } from '@shared/agents'
import { DEFAULT_PROFILE } from '@shared/profile'

const execFileAsync = promisify(execFile)

function log(ok: boolean, msg: string): boolean {
  console.log(`[SELFTEST] ${ok ? 'PASS' : 'FAIL'} — ${msg}`)
  return ok
}

export async function runSelfTest(): Promise<void> {
  let allOk = true
  let selftestWorktree: string | undefined
  const check = (ok: boolean, msg: string): void => {
    if (!log(ok, msg)) allOk = false
  }

  try {
    selftestWorktree = await mkdtemp(join(tmpdir(), 'orca-mcp-selftest-'))
    await execFileAsync('git', ['init'], { cwd: selftestWorktree, windowsHide: true })
    await execFileAsync('git', ['config', 'user.name', 'Vertragus Selftest'], { cwd: selftestWorktree, windowsHide: true })
    await execFileAsync('git', ['config', 'user.email', 'orca@example.invalid'], { cwd: selftestWorktree, windowsHide: true })
    await writeFile(join(selftestWorktree, 'README.md'), 'selftest\n')
    await execFileAsync('git', ['add', '--all'], { cwd: selftestWorktree, windowsHide: true })
    await execFileAsync('git', ['commit', '-m', 'selftest base'], { cwd: selftestWorktree, windowsHide: true })

    const handle = getMcpHandle()
    check(Boolean(handle), `MCP server running at ${handle ? new URL(handle.url).origin + '/mcp' : undefined}`)
    if (!handle) throw new Error('no handle')
    const unauthenticatedUrl = new URL(handle.url)
    unauthenticatedUrl.searchParams.delete('token')
    const unauthenticatedResponse = await fetch(unauthenticatedUrl)
    check(unauthenticatedResponse.status === 401, 'MCP rejects requests without the session token')

    const codexAdapter = getOrchestratorAdapter('codex')
    const codexArgs = codexAdapter.buildArgs({
      name: 'Virgilio',
      handle,
      configDir: app.getPath('userData'),
      systemPrompt: 'Orchestrate this session.'
    })
    check(
      codexAdapter.capability.supported &&
        codexAdapter.capability.transientConfig &&
        codexArgs.some((arg) => arg.startsWith('developer_instructions=')) &&
        codexArgs.some((arg) => arg.startsWith('mcp_servers.orca.url=')) &&
        codexArgs.some((arg) => arg.startsWith('mcp_servers.orca.enabled_tools=')),
      'Codex adapter uses transient developer instructions and MCP overrides'
    )
    check(
      getOrchestratorAdapter('cursor').capability.supported === false,
      'unsupported providers fail closed instead of pretending to orchestrate'
    )

    // Semaphore: limit 2, 4 acquires -> 2 run, 2 queue; releases let them through.
    {
      const sem = new Semaphore(2)
      const order: number[] = []
      await sem.acquire()
      await sem.acquire()
      const p3 = sem.acquire().then(() => order.push(3))
      const p4 = sem.acquire().then(() => order.push(4))
      await new Promise((r) => setTimeout(r, 10))
      const blockedInitially = order.length === 0 && sem.inUse === 2
      sem.release()
      sem.release()
      await Promise.all([p3, p4])
      check(
        blockedInitially && order.length === 2,
        `semaphore caps concurrency at limit (queued then released: ${order.join(',')})`
      )
    }

    // Stub runTask so dispatch resolves instantly without a real CLI.
    const dispatched: Array<{ provider: string; role: string; prompt: string }> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(agentManager as any).runTask = async (req: {
      provider: string
      model: string
      role: string
      taskId: string
      prompt: string
    }): Promise<{ info: AgentInstanceInfo; done: Promise<{ result: string; isError: boolean }> }> => {
      dispatched.push({ provider: req.provider, role: req.role, prompt: req.prompt })
      const info: AgentInstanceInfo = {
        id: `task-${dispatched.length}`,
        name: `Testagent-${dispatched.length}`,
        provider: req.provider as AgentInstanceInfo['provider'],
        model: req.model,
        role: `Task · ${req.role}`,
        kind: 'sub',
        mode: 'task',
        taskId: req.taskId,
        yolo: false,
        workingDir: selftestWorktree!,
        worktree: selftestWorktree!,
        status: 'running',
        startedAt: Date.now()
      }
      return { info, done: Promise.resolve({ result: `STUB-RESULT für: ${req.prompt}`, isError: false }) }
    }

    const client = new Client({ name: 'orca-selftest', version: '0.0.1' })
    const transport = new StreamableHTTPClientTransport(new URL(handle.url))
    await client.connect(transport)
    check(true, 'MCP client connected + initialized')

    const pollJson = async <T extends { status?: string }>(
      tool: string,
      args: Record<string, unknown>,
      terminal: (value: T) => boolean
    ): Promise<T> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = (await client.callTool({ name: tool, arguments: args })) as {
          content: Array<{ text: string }>
        }
        const value = JSON.parse(response.content[0].text) as T
        if (terminal(value)) return value
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('Polling timeout for ' + tool)
    }

    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name).sort()
    check(
      names.join(',') ===
        'acknowledge_handoff,await_any,await_plan,await_plan_approval,await_task,cancel_plan,dispatch_batch,dispatch_subagent,execute_plan,get_benchmark_status,get_handoff_context,get_plan_status,get_retro_draft,get_task_status,list_findings,list_multiagent_runs,list_subagent_requests,list_subagents,list_tasks,open_subwindow,record_benchmark,record_retro,report_activity,respond_subagent,review_multiagent,revoke_learning,run_benchmark,set_goal',
      `tools/list returned: ${names.join(', ')}`
    )

    orchestratorEngine.reset()
    const goalRes = (await client.callTool({
      name: 'set_goal',
      arguments: { title: 'Selbsttest-Ziel' }
    })) as { content: Array<{ text: string }> }
    check(
      orchestratorEngine.snapshot().goal?.title === 'Selbsttest-Ziel',
      `set_goal -> engine goal set (${goalRes.content[0]?.text})`
    )
    const activityRes = (await client.callTool({
      name: 'report_activity',
      arguments: {
        phase: 'planning',
        summary: 'Prüft Ziel und Rollen.',
        details: ['Vergleicht Aufgaben mit verfügbarer Kapazität.'],
        nextStep: 'Plan erstellen.'
      }
    })) as { content: Array<{ text: string }> }
    const reportedActivity = JSON.parse(activityRes.content[0].text) as { phase: string }
    check(
      reportedActivity.phase === 'planning' && orchestratorEngine.snapshot().activity?.phase === 'planning',
      'report_activity -> live coordinator status stored'
    )

    const listRes = (await client.callTool({ name: 'list_subagents', arguments: {} })) as {
      content: Array<{ text: string }>
    }
    const subs = JSON.parse(listRes.content[0].text) as Array<{ role: string }>
    check(subs.length > 0, `list_subagents -> ${subs.length} slot(s): ${subs.map((s) => s.role).join(', ')}`)
    check(
      new Set(subs.map((s) => s.role)).size === subs.length,
      `subagent roles are unique: ${subs.map((s) => s.role).join(', ')}`
    )

    const dispRes = (await client.callTool({
      name: 'dispatch_subagent',
      arguments: { role: subs[0].role, prompt: 'Implementiere Feature X', title: 'Feature X' }
    })) as { content: Array<{ text: string }> }
    const accepted = JSON.parse(dispRes.content[0].text) as { taskId: string }
    check(Boolean(accepted.taskId), 'dispatch_subagent -> accepted taskId ' + accepted.taskId)
    const completed = await pollJson<{ status: string; result?: string }>(
      'get_task_status', { taskId: accepted.taskId }, (value) => ['success', 'error', 'stopped'].includes(value.status)
    )
    check(completed.result?.includes('STUB-RESULT') === true, 'get_task_status returns final worker result')
    check(dispatched.length === 1, 'dispatch invoked runTask exactly once (' + dispatched.length + ')')

    const snap = orchestratorEngine.snapshot()
    const task = snap.tasks[0]
    check(
      task?.status === 'success' && task.title === 'Feature X',
      'DAG updated: task ' + task?.title + ' status=' + task?.status
    )
    check(
      task?.agentName === 'Testagent-1' && completed.result?.includes('Testagent-1') === true,
      'subagent name flows to DAG + result (' + task?.agentName + ')'
    )

    // Two same-named slots must become individually addressable, and dispatch
    // must route to the RIGHT provider (Bug 2 regression guard).
    const origActive = getActiveProfileId()
    const testId = 'selftest-multi'
    saveProfile({
      ...DEFAULT_PROFILE,
      id: testId,
      name: 'Selftest Multi',
      workingDir: '',
      orchestrator: { provider: 'claude', model: 'fable', autoOpenSubwindows: true },
      agents: [
        {
          role: 'worker', provider: 'codex', model: '', count: 1, orchestrated: true,
          yolo: false, strengths: [], weaknesses: []
        },
        {
          role: 'worker', provider: 'cursor', model: 'composer', count: 6, orchestrated: true,
          yolo: false, strengths: [], weaknesses: []
        }
      ],
      yoloDefault: false,
      planner: { ...DEFAULT_PROFILE.planner, mode: 'auto' },
    })
    setActiveProfileId(testId)
    try {
      const multi = (await client.callTool({ name: 'list_subagents', arguments: {} })) as {
        content: Array<{ text: string }>
      }
      const mslots = JSON.parse(multi.content[0].text) as Array<{ role: string; provider: string }>
      check(
        mslots.length === 2 && new Set(mslots.map((s) => s.role)).size === 2,
        `two same-named slots get unique roles: ${mslots.map((s) => `${s.role}(${s.provider})`).join(', ')}`
      )
      const cursorRole = mslots.find((s) => s.provider === 'cursor')!.role
      dispatched.length = 0
      const routedResponse = (await client.callTool({
        name: 'dispatch_subagent',
        arguments: { role: cursorRole, prompt: 'Composer-Aufgabe' }
      })) as { content: Array<{ text: string }> }
      const routedTask = JSON.parse(routedResponse.content[0].text) as { taskId: string }
      await pollJson('get_task_status', { taskId: routedTask.taskId }, (value) => value.status !== 'queued' && value.status !== 'running')
      check(
        dispatched[0]?.provider === 'cursor',
        `dispatch(role="${cursorRole}") routed to cursor (got ${dispatched[0]?.provider})`
      )

      dispatched.length = 0
      const batchRes = (await client.callTool({
        name: 'dispatch_batch',
        arguments: {
          tasks: [
            { role: cursorRole, prompt: 'A' },
            { role: cursorRole, prompt: 'B' },
            { role: cursorRole, prompt: 'C' }
          ]
        }
      })) as { content: Array<{ text: string }> }
      const acceptedBatch = JSON.parse(batchRes.content[0].text) as Array<{ taskId: string }>
      await Promise.all(acceptedBatch.map((item) =>
        pollJson('get_task_status', { taskId: item.taskId }, (value) => value.status !== 'queued' && value.status !== 'running')
      ))
      check(
        dispatched.length === 3 && acceptedBatch.length === 3,
        'dispatch_batch accepted and ran 3 tasks (ran ' + dispatched.length + ')'
      )
      dispatched.length = 0
      const planResponse = (await client.callTool({
        name: 'execute_plan',
        arguments: {
          plan: {
            version: 1,
            goal: 'Validated DAG',
            maxParallel: 2,
            tasks: [
              {
                id: 'inspect-a',
                title: 'Inspect A',
                role: cursorRole,
                prompt: 'PLAN-A',
                dependsOn: [],
                conflictKeys: ['area-a']
              },
              {
                id: 'inspect-b',
                title: 'Inspect B',
                role: cursorRole,
                prompt: 'PLAN-B',
                dependsOn: [],
                conflictKeys: ['area-b']
              },
              {
                id: 'integrate',
                title: 'Integrate',
                role: cursorRole,
                prompt: 'PLAN-C',
                dependsOn: ['inspect-a', 'inspect-b'],
                conflictKeys: ['area-a', 'area-b']
              }
            ]
          }
        }
      })) as { content: Array<{ text: string }> }
      const planAccepted = JSON.parse(planResponse.content[0].text) as { runId: string }
      let planApproved = false
      for (let attempt = 0; attempt < 100 && !planApproved; attempt += 1) {
        planApproved = orchestratorEngine.reviewPlan(true)
        if (!planApproved) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      check(planApproved, 'first auto plan enters and passes the review gate')
      const planRun = await pollJson<{ status: string; result?: { usedFallback: boolean; tasks: Array<{ status: string }> } }>(
        'get_plan_status', { runId: planAccepted.runId }, (value) => value.status !== 'running'
      )
      const planResult = planRun.result!
      const planAPosition = dispatched.findIndex((item) => item.prompt.includes('PLAN-A'))
      const planBPosition = dispatched.findIndex((item) => item.prompt.includes('PLAN-B'))
      const planCPosition = dispatched.findIndex((item) => item.prompt.includes('PLAN-C'))
      check(
        !planResult.usedFallback &&
          planResult.tasks.every((task) => task.status === 'success') &&
          planAPosition >= 0 &&
          planBPosition >= 0 &&
          planCPosition > planAPosition &&
          planCPosition > planBPosition,
        'execute_plan runs prerequisites before dependent DAG nodes'
      )

      const fallbackRun = orchestratorEngine.executePlan({
        version: 1,
        goal: 'Cycle fallback',
        maxParallel: 2,
        tasks: [
          { id: 'x', title: 'X', role: cursorRole, prompt: 'X', dependsOn: ['y'], conflictKeys: [] },
          { id: 'y', title: 'Y', role: cursorRole, prompt: 'Y', dependsOn: ['x'], conflictKeys: [] }
        ]
      })
      let fallbackApproved = false
      for (let attempt = 0; attempt < 100 && !fallbackApproved; attempt += 1) {
        fallbackApproved = orchestratorEngine.reviewPlan(true)
        if (!fallbackApproved) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      check(fallbackApproved, 'validated fallback enters and passes the review gate')
      const fallback = await fallbackRun
      check(
        fallback.usedFallback &&
          fallback.tasks.length === 1 &&
          fallback.validationIssues.some((issue) => issue.code === 'dependency_cycle'),
        'cyclic plans fail closed to one validated fallback task'
      )
    } finally {
      setActiveProfileId(origActive)
      deleteProfile(testId)
    }

    await client.close()
  } catch (err) {
    check(false, `threw: ${err instanceof Error ? err.stack : String(err)}`)
  }

  if (selftestWorktree) await rm(selftestWorktree, { recursive: true, force: true })
  console.log(`[SELFTEST] ${allOk ? 'ALL PASSED' : 'FAILURES PRESENT'}`)
  app.exit(allOk ? 0 : 1)
}
