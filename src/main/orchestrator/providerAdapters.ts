import type { AgentProviderId } from '@shared/providers'
import type { OrchestratorProviderCapability } from '@shared/orchestrator'
import type { McpServerHandle } from '@main/orchestrator/mcpHandle'
import {
  buildClaudeMcpArgs,
  buildCodexMcpArgs,
  buildCopilotMcpArgs,
  buildKimiMcpArgs,
  type McpServerSpec
} from '@main/orchestrator/mcpConfig'

export interface OrchestratorAdapterContext {
  name: string
  handle: McpServerHandle
  configDir: string
  systemPrompt: string
  /**
   * User-configured external MCP servers scoped to the orchestrator. Merged
   * alongside the Orca server so the orchestrator sees them too. Optional for
   * backward compatibility with callers that only wire the Orca server.
   */
  externalServers?: McpServerSpec[]
  /** Unique config-file suffix (Claude). Defaults to a stable orchestrator tag. */
  fileTag?: string
}

export interface OrchestratorAdapter {
  capability: OrchestratorProviderCapability
  buildArgs(context: OrchestratorAdapterContext): string[]
}

/** The Orca MCP server as a normalized spec (explicit tool allowlist). */
function orcaSpec(handle: McpServerHandle): McpServerSpec {
  return {
    name: 'orca',
    transport: 'http',
    url: handle.url,
    allowedTools: handle.allowedTools,
    required: true,
    // This loopback server is created and narrowly scoped by Orca itself.
    approvalMode: 'approve'
  }
}

const claudeAdapter: OrchestratorAdapter = {
  capability: {
    provider: 'claude',
    supported: true,
    transport: 'mcp-http',
    transientConfig: true
  },
  buildArgs({ handle, configDir, systemPrompt, externalServers, fileTag }) {
    const servers = [orcaSpec(handle), ...(externalServers ?? [])]
    return buildClaudeMcpArgs(servers, {
      configDir,
      fileTag: fileTag ?? 'orchestrator',
      strict: true,
      systemPrompt,
      includeReadonlyTools: true
    })
  }
}

const kimiAdapter: OrchestratorAdapter = {
  capability: {
    provider: 'kimi',
    supported: true,
    transport: 'mcp-http',
    transientConfig: true
  },
  buildArgs({ handle, configDir, systemPrompt, externalServers, fileTag }) {
    // Kimi Code CLI attaches the Orca MCP server exactly like Claude, differing
    // only in the config-file flag handled by buildKimiMcpArgs.
    const servers = [orcaSpec(handle), ...(externalServers ?? [])]
    return buildKimiMcpArgs(servers, {
      configDir,
      fileTag: fileTag ?? 'orchestrator',
      strict: true,
      systemPrompt,
      includeReadonlyTools: true
    })
  }
}

const codexAdapter: OrchestratorAdapter = {
  capability: {
    provider: 'codex',
    supported: true,
    transport: 'mcp-http',
    transientConfig: true
  },
  buildArgs({ handle, systemPrompt, externalServers }) {
    // Every override is process-local. Nothing is written to ~/.codex/config.toml.
    const servers = [orcaSpec(handle), ...(externalServers ?? [])]
    return buildCodexMcpArgs(servers, { systemPrompt })
  }
}

const copilotAdapter: OrchestratorAdapter = {
  capability: {
    provider: 'copilot',
    supported: true,
    transport: 'mcp-http',
    transientConfig: true
  },
  buildArgs({ handle, externalServers }) {
    const servers = [orcaSpec(handle), ...(externalServers ?? [])]
    return buildCopilotMcpArgs(servers)
  }
}

function unsupported(provider: AgentProviderId): OrchestratorAdapter {
  return {
    capability: {
      provider,
      supported: false,
      transport: 'none',
      transientConfig: true,
      reason: 'Dieser Provider hat noch keinen verifizierten MCP-Orchestrator-Adapter.'
    },
    buildArgs: () => []
  }
}

const ADAPTERS: Record<AgentProviderId, OrchestratorAdapter> = {
  claude: claudeAdapter,
  kimi: kimiAdapter,
  codex: codexAdapter,
  cursor: unsupported('cursor'),
  copilot: copilotAdapter,
  ollama: unsupported('ollama')
}

export function getOrchestratorAdapter(provider: AgentProviderId): OrchestratorAdapter {
  return ADAPTERS[provider]
}

export function listOrchestratorCapabilities(): OrchestratorProviderCapability[] {
  return Object.values(ADAPTERS).map((adapter) => ({ ...adapter.capability }))
}
