/**
 * Model suggestions per agent provider. These are only *suggestions* — the
 * ProfileEditor lets the user type any model name, because valid models depend
 * on each CLI's version and the user's subscription (e.g. codex with a ChatGPT
 * account rejects gpt-5 / gpt-5.6). Ollama and codex are resolved live.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MODELS, type AgentProviderId } from '@shared/providers'

/** The model configured in ~/.codex/config.toml — the one codex actually uses. */
function codexConfiguredModel(): string | undefined {
  try {
    const toml = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    return toml.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]
  } catch {
    return undefined
  }
}

export async function listModels(): Promise<Record<AgentProviderId, string[]>> {
  const models: Record<AgentProviderId, string[]> = {
    claude: [...DEFAULT_MODELS.claude],
    codex: [...DEFAULT_MODELS.codex],
    cursor: [...DEFAULT_MODELS.cursor],
    ollama: [...DEFAULT_MODELS.ollama]
  }

  // codex: surface the user's actual configured model first.
  const codexModel = codexConfiguredModel()
  if (codexModel) models.codex = [codexModel, ...models.codex.filter((m) => m !== codexModel)]

  // ollama: live model list from the local daemon.
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(3000)
    })
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    const live = (data.models ?? []).map((m) => m.name)
    if (live.length > 0) models.ollama = live
  } catch {
    // daemon offline — keep fallback list
  }
  return models
}
