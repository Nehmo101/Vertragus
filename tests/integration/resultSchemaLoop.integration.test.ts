/**
 * S3 integration: the resultSchema loop over a REAL MCP server, driven over
 * HTTP exactly as the models would.
 *
 *   real MCP server (node:http, random port)
 *     ↑ fake orchestrator = real MCP SDK client on the orchestrator URL
 *     ↑ "agent session"   = real MCP SDK client on that agent's subagent URL
 *
 * The host is a real {@link Workspace} with fake spawn/seed/worktrees — no
 * processes and no git, because what is under test here is the schema
 * lifecycle across the two tool surfaces: `start_agent{resultSchema}` vets and
 * registers the schema, `report_done` validates against it (the retry loop
 * runs at the CHILD — a failed validation delivers nothing to the parent),
 * and `stop_agent` clears it. No sleeps: every step waits for a tool result
 * or an actual queued event; the 1 s empty long-poll is the upper bound that
 * PROVES nothing was delivered.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startMcpServer } from '@main/mcp/server'
import type { WorkspaceRuntime } from '@main/mcp/types'
import type { AgentEvent } from '@shared/schema/events'
import { Workspace, type WorkspaceDeps } from '@main/workspace/Workspace'
import {
  FakeRegistry,
  FakeWindows,
  fakeSeed,
  fakeSpawn,
  fakeWorktrees,
  sequentialIds,
  testProfile,
  testProviders
} from '@main/workspace/testing'

const TEST_TIMEOUT = 30_000

/** The contract of scenario (a): a tester reports pass/fail plus failures. */
const TESTER_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'string' } }
  },
  required: ['pass']
} as const

type ToolResult = Record<string, unknown> & { __isError: boolean; __text: string }

interface Harness {
  workspace: Workspace
  /** The MCP-owned runtime — where the schema registry (S3) lives. */
  runtime: WorkspaceRuntime
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  /** A second identity: the AGENT's own MCP session, like its CLI would open. */
  agentCall(agentId: string, name: string, args?: Record<string, unknown>): Promise<ToolResult>
  dispose(): Promise<void>
}

const openHarnesses: Harness[] = []

async function callOn(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
  } catch {
    json = {}
  }
  return { ...json, __isError: result.isError === true, __text: text }
}

async function makeHarness(): Promise<Harness> {
  const handle = await startMcpServer()
  const workspace = new Workspace(
    {
      profile: testProfile({
        slots: [
          { id: 'slot-worker', roleId: 'worker', providerId: 'claude' },
          // The tester-ish role the schema is stated for.
          { id: 'slot-tester', roleId: 'tester', providerId: 'claude' }
        ]
      }),
      name: 'Schema'
    },
    {
      registry: new FakeRegistry(),
      windows: new FakeWindows(),
      configDir: '/repo/.vertragus-config',
      providers: testProviders(),
      // Fake everything process- and git-shaped: the schema loop is pure
      // tool-layer behaviour and must not depend on a repository.
      spawn: fakeSpawn().spawn as unknown as WorkspaceDeps['spawn'],
      seed: fakeSeed().seed as unknown as WorkspaceDeps['seed'],
      createWorktree: fakeWorktrees().createWorktree,
      newId: sequentialIds('agent')
    }
  )
  // Mirror the WorkspaceManager wiring: register first, then attach the URLs
  // and the shared question registry.
  const registered = handle.registerWorkspace(workspace.mcpContext())
  workspace.attachMcp(registered)
  workspace.attachQuestions(registered.runtime.questions)

  const orchestrator = new Client({ name: 'fake-orchestrator', version: '1.0.0' })
  await orchestrator.connect(new StreamableHTTPClientTransport(new URL(registered.orchestratorUrl)))
  const agentClients = new Map<string, Promise<Client>>()

  const harness: Harness = {
    workspace,
    runtime: registered.runtime,
    call: (name, args = {}) => callOn(orchestrator, name, args),
    async agentCall(agentId, name, args = {}) {
      let pending = agentClients.get(agentId)
      if (!pending) {
        pending = (async () => {
          const client = new Client({ name: `fake-agent-${agentId}`, version: '1.0.0' })
          await client.connect(
            new StreamableHTTPClientTransport(new URL(registered.subagentUrl(agentId)))
          )
          return client
        })()
        agentClients.set(agentId, pending)
      }
      return callOn(await pending, name, args)
    },
    async dispose() {
      for (const pending of agentClients.values()) {
        await (await pending).close().catch(() => undefined)
      }
      await orchestrator.close().catch(() => undefined)
      await workspace.close()
      await handle.close()
    }
  }
  openHarnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (openHarnesses.length > 0) await openHarnesses.pop()!.dispose()
})

interface AwaitResult {
  events: AgentEvent[]
  cursor: number
  note?: string
}

async function awaitEvents(harness: Harness, cursor: number, timeoutSec = 15): Promise<AwaitResult> {
  return (await harness.call('await_events', { cursor, timeoutSec })) as unknown as AwaitResult
}

/** Start one agent through the tool and block until ITS agent_started landed. */
async function startAgent(
  harness: Harness,
  args: Record<string, unknown>,
  cursor = 0
): Promise<{ agentId: string; cursor: number }> {
  const started = await harness.call('start_agent', args)
  expect(started.__isError).toBe(false)
  const agentId = String(started.agentId)
  // Blocks, never polls: earlier buffered events (a quiet agent_stopped, say)
  // may return first, so keep long-polling until this agent's start arrived.
  for (let round = 0; round < 8; round++) {
    const result = await awaitEvents(harness, cursor)
    cursor = result.cursor
    if (
      result.events.some((event) => event.type === 'agent_started' && event.agentId === agentId)
    ) {
      return { agentId, cursor }
    }
  }
  throw new Error(`agent_started for ${agentId} never arrived`)
}

describe('S3 resultSchema loop — invalid parks, valid delivers, stop clears', () => {
  it(
    '(a–c) rejects a non-conforming report_done without delivering, then delivers the valid result',
    async () => {
      const harness = await makeHarness()

      // (a) The orchestrator states the contract at start time.
      const { agentId, cursor } = await startAgent(harness, {
        role: 'tester',
        task: 'Run the checks and report pass/failures.',
        resultSchema: TESTER_RESULT_SCHEMA
      })

      // (b) The agent reports a NON-conforming result: wrong type on `pass`,
      // wrong type on `failures`. The tool error names BOTH problem paths and
      // the report is not delivered.
      const invalid = await harness.agentCall(agentId, 'report_done', {
        summary: 'Checks ran.',
        result: { pass: 'yes', failures: 'none' }
      })
      expect(invalid.__isError).toBe(true)
      expect(invalid.error).toBe('invalid_result')
      const problems = invalid.problems as string[]
      expect(problems.some((problem) => problem.startsWith('result.pass:'))).toBe(true)
      expect(problems.some((problem) => problem.startsWith('result.failures:'))).toBe(true)

      // A missing result under a stated schema is refused the same way.
      const missing = await harness.agentCall(agentId, 'report_done', { summary: 'Checks ran.' })
      expect(missing.__isError).toBe(true)
      expect(missing.error).toBe('invalid_result')

      // No agent_done reached the queue: a parked await_events stays parked —
      // the short-timeout long-poll comes back EMPTY, not with a done.
      const parked = await awaitEvents(harness, cursor, 1)
      expect(parked.events).toEqual([])
      expect(String(parked.note)).toMatch(/call await_events again/i)
      expect(
        harness.workspace.events.all().some((event) => event.type === 'agent_done')
      ).toBe(false)

      // (c) The corrected report validates and is delivered — the orchestrator
      // reads the result machine-readably, not as prose.
      const valid = await harness.agentCall(agentId, 'report_done', {
        summary: 'All checks pass.',
        result: { pass: true, failures: [] }
      })
      expect(valid.__isError).toBe(false)
      expect(valid.ok).toBe(true)

      const delivered = await awaitEvents(harness, parked.cursor)
      const done = delivered.events.find((event) => event.type === 'agent_done')
      expect(done).toBeDefined()
      expect(done).toMatchObject({ agentId, status: 'success' })
      const result = (done as { result?: { pass?: unknown; failures?: unknown } }).result
      expect(result?.pass).toBe(true)
      expect(result?.failures).toEqual([])
    },
    TEST_TIMEOUT
  )

  it(
    '(d) refuses an unsupported schema (oneOf) fail-loud — nothing is started',
    async () => {
      const harness = await makeHarness()

      const refused = await harness.call('start_agent', {
        role: 'tester',
        task: 'Never runs.',
        resultSchema: { oneOf: [{ type: 'object' }, { type: 'null' }] }
      })
      expect(refused.__isError).toBe(true)
      expect(refused.error).toBe('invalid_result_schema')
      const problems = refused.problems as string[]
      expect(problems.some((problem) => problem.includes('oneOf'))).toBe(true)

      // Fail-loud means fail-EARLY: no reservation, no agent, no event.
      const snapshot = await harness.call('list_agents')
      expect(snapshot.agents).toEqual([])
      expect(harness.workspace.events.all()).toEqual([])
    },
    TEST_TIMEOUT
  )

  it(
    '(e) clears the schema on stop_agent, and a schema-free agent reports freely',
    async () => {
      const harness = await makeHarness()

      const { agentId, cursor } = await startAgent(harness, {
        role: 'tester',
        task: 'Report with a schema.',
        resultSchema: TESTER_RESULT_SCHEMA
      })
      expect(harness.runtime.resultSchemas.has(agentId)).toBe(true)

      const stopped = await harness.call('stop_agent', { agentId })
      expect(stopped.ok).toBe(true)
      // The lifecycle promise: a stopped agent reports nothing more, so its
      // schema goes too — no stale entry outlives the agent.
      expect(harness.runtime.resultSchemas.has(agentId)).toBe(false)

      // Behavioural counterpart: a fresh agent started WITHOUT a schema
      // reports freely — result optional, nothing validates.
      const { agentId: free } = await startAgent(
        harness,
        { role: 'worker', task: 'Report without a schema.' },
        cursor
      )
      const report = await harness.agentCall(free, 'report_done', { summary: 'Done, unschemed.' })
      expect(report.__isError).toBe(false)
      expect(report.ok).toBe(true)
    },
    TEST_TIMEOUT
  )
})
