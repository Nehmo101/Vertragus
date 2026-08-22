/**
 * The argv matrix: every preset × every agent kind × the launch knobs, pinned
 * as inline snapshots.
 *
 * `spawn.test.ts` proves the RULES of argv composition (yolo never reaches an
 * orchestrator, MCP is always attached, prompt delivery is exclusive). This
 * file pins the RESULTS: the exact argument vector each shipped preset
 * produces, through the real production path (`buildAgentArgv`, the pure core
 * of `spawnAgent`), so that any edit to `presets.ts` — a changed flag, a
 * reordered argument, a dropped attach — shows up as a reviewable snapshot
 * diff instead of surfacing as a launch that dies on an unknown flag.
 *
 * Three variants per preset × kind:
 *   - `bare`         — no model, no effort, no yolo: the CLI on its defaults.
 *   - `full`         — model override, plus effort where the preset declares
 *                      an `effortArg`, yolo off.
 *   - `full+yolo`    — the same with yolo on (which by rule reaches subagents
 *                      only — the orchestrator snapshots prove that too).
 *
 * Transient file paths (Claude's MCP config, Kimi's agent file) are normalized
 * to placeholders so the snapshots stay machine-independent; the files
 * themselves are covered by spawn.test.ts. Only the argv is pinned here — the
 * PTY-delivered prompt (Cursor, Ollama) is by definition not in it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EffortLevel, ProviderConfig, ProviderPresetId } from '@shared/schema/provider'
import { PROVIDER_PRESET_IDS } from '@shared/schema/provider'
import { buildAgentArgv, type AgentLaunchInput, type AgentLaunchKind } from '@main/agents/spawn'
import { providerPreset } from './presets'

let configDir: string
/** Real directories: the Kimi/Cursor/Grok attach paths write into the cwd. */
let cwd: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'vertragus-matrix-'))
  cwd = mkdtempSync(join(tmpdir(), 'vertragus-matrix-cwd-'))
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

/** A deterministic, obviously-fake URL so the snapshots are stable. */
const MCP_URL = 'http://127.0.0.1:4711/mcp?ws=w1&agent=a1&token=T'
const PROMPT = 'SYSTEM PROMPT'

/** One plausible model id per preset, so the model arg shows its real shape. */
const MODEL: Record<ProviderPresetId, string> = {
  claude: 'opus',
  codex: 'gpt-5.6',
  kimi: 'kimi-code/k3',
  cursor: 'auto',
  grok: 'grok-build',
  ollama: 'qwen3:32b'
}

const KINDS: readonly AgentLaunchKind[] = ['orchestrator', 'subagent']
const EFFORT: EffortLevel = 'high'

function preset(id: ProviderPresetId): ProviderConfig {
  const config = providerPreset(id)
  if (!config) throw new Error(`missing preset ${id}`)
  return config
}

/** Replace transient file paths so expectations stay machine-independent. */
function normalize(argv: string[]): string[] {
  return argv.map((arg) => {
    if (!arg.startsWith(configDir)) return arg
    return arg.endsWith('.agent.md') ? '<agent-file.md>' : '<mcp-config.json>'
  })
}

function build(
  provider: ProviderConfig,
  kind: AgentLaunchKind,
  overrides: Partial<AgentLaunchInput>
): string[] {
  const input: AgentLaunchInput = {
    kind,
    provider,
    cwd,
    mcpUrl: MCP_URL,
    fileTag: 'matrix',
    configDir,
    systemPrompt: PROMPT,
    ...overrides
  }
  return normalize(buildAgentArgv(input).argv)
}

/**
 * The three launch variants of one preset × kind. Effort is only set where the
 * preset declares an `effortArg` — passing it to a CLI without the knob is a
 * no-op by construction (`buildEffortArgs`), and the snapshot should show what
 * a real launch sends, not exercise the no-op.
 */
function variants(id: ProviderPresetId, kind: AgentLaunchKind): Record<string, string[]> {
  const config = preset(id)
  const effort = config.effortArg ? { effort: EFFORT } : {}
  return {
    bare: build(config, kind, {}),
    full: build(config, kind, { model: MODEL[id], ...effort, yolo: false }),
    'full+yolo': build(config, kind, { model: MODEL[id], ...effort, yolo: true })
  }
}

/** Every combination of one preset, keyed `<kind> <variant>`. */
function matrixFor(id: ProviderPresetId): Record<string, string[]> {
  const rows: Record<string, string[]> = {}
  for (const kind of KINDS) {
    for (const [name, argv] of Object.entries(variants(id, kind))) {
      rows[`${kind} ${name}`] = argv
    }
  }
  return rows
}

describe('preset argv matrix', () => {
  /**
   * The self-check: 6 presets × 2 kinds × 3 variants = 36 combinations. If a
   * preset is added or a variant dropped, this number moves and the matrix has
   * to be extended deliberately — a snapshot suite that silently covers less
   * than it claims would pass for the wrong reason.
   */
  it('covers every preset × kind × variant combination', () => {
    const total = PROVIDER_PRESET_IDS.reduce(
      (sum, id) => sum + Object.keys(matrixFor(id)).length,
      0
    )
    expect(PROVIDER_PRESET_IDS.length).toBe(6)
    expect(total).toBe(36)
  })

  it('pins the Claude launch argv', () => {
    expect(matrixFor('claude')).toMatchInlineSnapshot(`
      {
        "orchestrator bare": [
          "--mcp-config",
          "<mcp-config.json>",
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__vertragus__start_agent,mcp__vertragus__send_to_agent,mcp__vertragus__await_events,mcp__vertragus__list_agents,mcp__vertragus__stop_agent,mcp__vertragus__read_output,mcp__vertragus__inspect_agent,mcp__vertragus__integrate_branch,mcp__vertragus__ask_user,mcp__vertragus__start_orchestrator,mcp__vertragus__record_retro,mcp__vertragus__request_succession,mcp__vertragus__search_runs,mcp__vertragus__task_create,mcp__vertragus__task_update,mcp__vertragus__task_list,Read,Glob,Grep,TodoWrite",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "orchestrator full": [
          "--model",
          "opus",
          "--effort",
          "high",
          "--mcp-config",
          "<mcp-config.json>",
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__vertragus__start_agent,mcp__vertragus__send_to_agent,mcp__vertragus__await_events,mcp__vertragus__list_agents,mcp__vertragus__stop_agent,mcp__vertragus__read_output,mcp__vertragus__inspect_agent,mcp__vertragus__integrate_branch,mcp__vertragus__ask_user,mcp__vertragus__start_orchestrator,mcp__vertragus__record_retro,mcp__vertragus__request_succession,mcp__vertragus__search_runs,mcp__vertragus__task_create,mcp__vertragus__task_update,mcp__vertragus__task_list,Read,Glob,Grep,TodoWrite",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "orchestrator full+yolo": [
          "--model",
          "opus",
          "--effort",
          "high",
          "--mcp-config",
          "<mcp-config.json>",
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__vertragus__start_agent,mcp__vertragus__send_to_agent,mcp__vertragus__await_events,mcp__vertragus__list_agents,mcp__vertragus__stop_agent,mcp__vertragus__read_output,mcp__vertragus__inspect_agent,mcp__vertragus__integrate_branch,mcp__vertragus__ask_user,mcp__vertragus__start_orchestrator,mcp__vertragus__record_retro,mcp__vertragus__request_succession,mcp__vertragus__search_runs,mcp__vertragus__task_create,mcp__vertragus__task_update,mcp__vertragus__task_list,Read,Glob,Grep,TodoWrite",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "subagent bare": [
          "--mcp-config",
          "<mcp-config.json>",
          "--strict-mcp-config",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "subagent full": [
          "--model",
          "opus",
          "--effort",
          "high",
          "--mcp-config",
          "<mcp-config.json>",
          "--strict-mcp-config",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "subagent full+yolo": [
          "--model",
          "opus",
          "--effort",
          "high",
          "--dangerously-skip-permissions",
          "--mcp-config",
          "<mcp-config.json>",
          "--strict-mcp-config",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
      }
    `)
  })

  it('pins the Codex launch argv', () => {
    expect(matrixFor('codex')).toMatchInlineSnapshot(`
      {
        "orchestrator bare": [
          "-c",
          "mcp_servers.vertragus.url="http://127.0.0.1:4711/mcp?ws=w1&agent=a1&token=T"",
          "-c",
          "mcp_servers.vertragus.required=true",
          "-c",
          "mcp_servers.vertragus.default_tools_approval_mode="approve"",
          "-c",
          "mcp_servers.vertragus.enabled_tools=["start_agent","send_to_agent","await_events","list_agents","stop_agent","read_output","inspect_agent","integrate_branch","ask_user","start_orchestrator","record_retro","request_succession","search_runs","task_create","task_update","task_list"]",
          "-c",
          "developer_instructions="SYSTEM PROMPT"",
        ],
        "orchestrator full": [
          "--model",
          "gpt-5.6",
          "-c",
          "model_reasoning_effort="high"",
          "-c",
          "mcp_servers.vertragus.url="http://127.0.0.1:4711/mcp?ws=w1&agent=a1&token=T"",
          "-c",
          "mcp_servers.vertragus.required=true",
          "-c",
          "mcp_servers.vertragus.default_tools_approval_mode="approve"",
          "-c",
          "mcp_servers.vertragus.enabled_tools=["start_agent","send_to_agent","await_events","list_agents","stop_agent","read_output","inspect_agent","integrate_branch","ask_user","start_orchestrator","record_retro","request_succession","search_runs","task_create","task_update","task_list"]",
          "-c",
          "developer_instructions="SYSTEM PROMPT"",
        ],
        "orchestrator full+yolo": [
          "--model",
          "gpt-5.6",
          "-c",
          "model_reasoning_effort="high"",
          "-c",
          "mcp_servers.vertragus.url="http://127.0.0.1:4711/mcp?ws=w1&agent=a1&token=T"",
          "-c",
          "mcp_servers.vertragus.required=true",
          "-c",
          "mcp_servers.vertragus.default_tools_approval_mode="approve"",
          "-c",
          "mcp_servers.vertragus.enabled_tools=["start_agent","send_to_agent","await_events","list_agents","stop_agent","read_output","inspect_agent","integrate_branch","ask_user","start_orchestrator","record_retro","request_succession","search_runs","task_create","task_update","task_list"]",
          "-c",
          "developer_instructions="SYSTEM PROMPT"",
        ],
        "subagent bare": [
          "-c",
          "mcp_servers.vertragus.url="http://127.0.0.1:4711/mcp?ws=w1&agent=a1&token=T"",
          "-c",
          "mcp_servers.vertragus.required=true",
          "-c",
          "mcp_servers.vertragus.default_tools_approval_mode="approve"",
          "-c",
          "developer_instructions="SYSTEM PROMPT"",
        ],
        "subagent full": [
          "--model",
          "gpt-5.6",
          "-c",
          "model_reasoning_effort="high"",
          "-c",
          "mcp_servers.vertragus.url="http://127.0.0.1:4711/mcp?ws=w1&agent=a1&token=T"",
          "-c",
          "mcp_servers.vertragus.required=true",
          "-c",
          "mcp_servers.vertragus.default_tools_approval_mode="approve"",
          "-c",
          "developer_instructions="SYSTEM PROMPT"",
        ],
        "subagent full+yolo": [
          "--model",
          "gpt-5.6",
          "-c",
          "model_reasoning_effort="high"",
          "--dangerously-bypass-approvals-and-sandbox",
          "-c",
          "mcp_servers.vertragus.url="http://127.0.0.1:4711/mcp?ws=w1&agent=a1&token=T"",
          "-c",
          "mcp_servers.vertragus.required=true",
          "-c",
          "mcp_servers.vertragus.default_tools_approval_mode="approve"",
          "-c",
          "developer_instructions="SYSTEM PROMPT"",
        ],
      }
    `)
  })

  it('pins the Kimi launch argv', () => {
    expect(matrixFor('kimi')).toMatchInlineSnapshot(`
      {
        "orchestrator bare": [
          "--agent-file",
          "<agent-file.md>",
        ],
        "orchestrator full": [
          "--model",
          "kimi-code/k3",
          "--agent-file",
          "<agent-file.md>",
        ],
        "orchestrator full+yolo": [
          "--model",
          "kimi-code/k3",
          "--agent-file",
          "<agent-file.md>",
        ],
        "subagent bare": [
          "--agent-file",
          "<agent-file.md>",
        ],
        "subagent full": [
          "--model",
          "kimi-code/k3",
          "--agent-file",
          "<agent-file.md>",
        ],
        "subagent full+yolo": [
          "--model",
          "kimi-code/k3",
          "--yolo",
          "--agent-file",
          "<agent-file.md>",
        ],
      }
    `)
  })

  it('pins the Cursor launch argv', () => {
    expect(matrixFor('cursor')).toMatchInlineSnapshot(`
      {
        "orchestrator bare": [
          "--trust",
          "--approve-mcps",
        ],
        "orchestrator full": [
          "--trust",
          "--model",
          "auto",
          "--approve-mcps",
        ],
        "orchestrator full+yolo": [
          "--trust",
          "--model",
          "auto",
          "--approve-mcps",
        ],
        "subagent bare": [
          "--trust",
          "--approve-mcps",
        ],
        "subagent full": [
          "--trust",
          "--model",
          "auto",
          "--approve-mcps",
        ],
        "subagent full+yolo": [
          "--trust",
          "--model",
          "auto",
          "--yolo",
          "--approve-mcps",
        ],
      }
    `)
  })

  it('pins the Grok launch argv', () => {
    expect(matrixFor('grok')).toMatchInlineSnapshot(`
      {
        "orchestrator bare": [
          "--no-subagents",
          "--agent",
          "vertragus-orchestrator",
          "--deny",
          "Edit",
          "--deny",
          "Write",
          "--deny",
          "Bash",
          "--allow",
          "MCPTool(vertragus__*)",
          "--allow",
          "Read",
          "--allow",
          "Grep",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "orchestrator full": [
          "--model",
          "grok-build",
          "--effort",
          "high",
          "--no-subagents",
          "--agent",
          "vertragus-orchestrator",
          "--deny",
          "Edit",
          "--deny",
          "Write",
          "--deny",
          "Bash",
          "--allow",
          "MCPTool(vertragus__*)",
          "--allow",
          "Read",
          "--allow",
          "Grep",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "orchestrator full+yolo": [
          "--model",
          "grok-build",
          "--effort",
          "high",
          "--no-subagents",
          "--agent",
          "vertragus-orchestrator",
          "--deny",
          "Edit",
          "--deny",
          "Write",
          "--deny",
          "Bash",
          "--allow",
          "MCPTool(vertragus__*)",
          "--allow",
          "Read",
          "--allow",
          "Grep",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "subagent bare": [
          "--allow",
          "MCPTool(vertragus__*)",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "subagent full": [
          "--model",
          "grok-build",
          "--effort",
          "high",
          "--allow",
          "MCPTool(vertragus__*)",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
        "subagent full+yolo": [
          "--model",
          "grok-build",
          "--effort",
          "high",
          "--always-approve",
          "--allow",
          "MCPTool(vertragus__*)",
          "--append-system-prompt",
          "SYSTEM PROMPT",
        ],
      }
    `)
  })

  it('pins the Ollama launch argv', () => {
    expect(matrixFor('ollama')).toMatchInlineSnapshot(`
      {
        "orchestrator bare": [
          "run",
          "--nowordwrap",
        ],
        "orchestrator full": [
          "run",
          "--nowordwrap",
          "qwen3:32b",
        ],
        "orchestrator full+yolo": [
          "run",
          "--nowordwrap",
          "qwen3:32b",
        ],
        "subagent bare": [
          "run",
          "--nowordwrap",
        ],
        "subagent full": [
          "run",
          "--nowordwrap",
          "qwen3:32b",
        ],
        "subagent full+yolo": [
          "run",
          "--nowordwrap",
          "qwen3:32b",
        ],
      }
    `)
  })
})
