/**
 * Model options per agent provider. Static fallbacks from the shared registry;
 * ollama is queried live when the local daemon responds.
 */
import { DEFAULT_MODELS, type AgentProviderId } from '@shared/providers'

export async function listModels(): Promise<Record<AgentProviderId, string[]>> {
  const models: Record<AgentProviderId, string[]> = { ...DEFAULT_MODELS }
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
