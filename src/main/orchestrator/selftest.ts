/**
 * Integration self-test for the orchestration core. Enabled with
 * ORCA_MCP_SELFTEST=1. Connects a real MCP client to the running Orca MCP
 * server and exercises the tools end-to-end, stubbing agentManager.runTask so
 * no real (paid) CLI is spawned. Logs [SELFTEST] lines and quits.
 *
 * This verifies the value path: MCP tool call -> engine -> dispatch routing ->
 * result returned to the caller, plus the DAG snapshot updates.
 */
import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { agentManager } from '@main/agents/AgentManager'
import { orchestratorEngine } from '@main/orchestrator/Engine'
import { getMcpHandle } from '@main/orchestrator/mcpHandle'
import {
  saveProfile,
  deleteProfile,
  getActiveProfileId,
  setActiveProfileId
} from '@main/config/store'
import type { AgentInstanceInfo } from '@shared/agents'

function log(ok: boolean, msg: string): boolean {
  console.log(`[SELFTEST] ${ok ? 'PASS' : 'FAIL'} — ${msg}`)
  return ok
}

export async function runSelfTest(): Promise<void> {
  let allOk = true
  const check = (ok: boolean, msg: string): void => {
    if (!log(ok, msg)) allOk = false
  }

  try {
    const handle = getMcpHandle()
    check(Boolean(handle), `MCP server running at ${handle?.url}`)
    if (!handle) throw new Error('no handle')

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
        provider: req.provider as AgentInstanceInfo['provider'],
        model: req.model,
        role: `Task · ${req.role}`,
        kind: 'sub',
        mode: 'task',
        taskId: req.taskId,
        yolo: false,
        workingDir: '.',
        status: 'running',
        startedAt: Date.now()
      }
      return { info, done: Promise.resolve({ result: `STUB-RESULT für: ${req.prompt}`, isError: false }) }
    }

    const client = new Client({ name: 'orca-selftest', version: '0.0.1' })
    const transport = new StreamableHTTPClientTransport(new URL(handle.url))
    await client.connect(transport)
    check(true, 'MCP client connected + initialized')

    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name).sort()
    check(
      names.join(',') === 'dispatch_subagent,list_subagents,open_subwindow,set_goal',
      `tools/list returned: ${names.join(', ')}`
    )

    const goalRes = (await client.callTool({
      name: 'set_goal',
      arguments: { title: 'Selbsttest-Ziel' }
    })) as { content: Array<{ text: string }> }
    check(
      orchestratorEngine.snapshot().goal?.title === 'Selbsttest-Ziel',
      `set_goal -> engine goal set (${goalRes.content[0]?.text})`
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
    check(
      dispRes.content[0].text.includes('STUB-RESULT'),
      `dispatch_subagent -> result routed back: "${dispRes.content[0].text.slice(0, 40)}…"`
    )
    check(dispatched.length === 1, `dispatch invoked runTask exactly once (${dispatched.length})`)

    const snap = orchestratorEngine.snapshot()
    const task = snap.tasks[0]
    check(
      task?.status === 'success' && task.title === 'Feature X',
      `DAG updated: task "${task?.title}" status=${task?.status}`
    )

    // Two same-named slots must become individually addressable, and dispatch
    // must route to the RIGHT provider (Bug 2 regression guard).
    const origActive = getActiveProfileId()
    const testId = 'selftest-multi'
    saveProfile({
      id: testId,
      name: 'Selftest Multi',
      workingDir: '',
      orchestrator: { provider: 'claude', model: 'fable', autoOpenSubwindows: true },
      agents: [
        { role: 'worker', provider: 'codex', model: '', count: 1, orchestrated: true, yolo: false },
        { role: 'worker', provider: 'cursor', model: 'composer', count: 6, orchestrated: true, yolo: false }
      ],
      yoloDefault: false
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
      await client.callTool({
        name: 'dispatch_subagent',
        arguments: { role: cursorRole, prompt: 'Composer-Aufgabe' }
      })
      check(
        dispatched[0]?.provider === 'cursor',
        `dispatch(role="${cursorRole}") routed to cursor (got ${dispatched[0]?.provider})`
      )
    } finally {
      setActiveProfileId(origActive)
      deleteProfile(testId)
    }

    await client.close()
  } catch (err) {
    check(false, `threw: ${err instanceof Error ? err.stack : String(err)}`)
  }

  console.log(`[SELFTEST] ${allOk ? 'ALL PASSED' : 'FAILURES PRESENT'}`)
  app.exit(allOk ? 0 : 1)
}
