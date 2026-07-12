/**
 * Model suggestions per agent provider. These are only *suggestions* — the
 * ProfileEditor lets the user type any model name, because valid models depend
 * on each CLI's version and the user's subscription (e.g. codex with a ChatGPT
 * account rejects gpt-5 / gpt-5.6). Ollama and codex are resolved live;
 * cursor uses `cursor-agent models` when available (no other provider exposes
 * a reliable discovery API — curated PRESET_MODELS + DEFAULT_MODELS apply).
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_MODELS, type AgentProviderId } from '@shared/providers'

const execFileAsync = promisify(execFile)

/** The model configured in ~/.codex/config.toml — the one codex actually uses. */
function codexConfiguredModel(): string | undefined {
  try {
    const toml = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    return toml.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Live model list from cursor-agent. Falls back to undefined when the CLI is
 * missing, unauthenticated, or times out — caller keeps curated defaults.
 */
async function listCursorModels(): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync('cursor-agent', ['models'], {
      timeout: 8000,
      windowsHide: true
    })
    const ids = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^available models/i.test(line))
      .map((line) => line.split(' - ')[0]?.trim())
      .filter((id): id is string => Boolean(id))
    return ids.length > 0 ? [...new Set(ids)] : undefined
  } catch {
    return undefined
  }
}

function mergeUnique(primary: string[], extra: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...primary, ...extra]) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export async function listModels(): Promise<Record<AgentProviderId, string[]>> {
  const models: Record<AgentProviderId, string[]> = {
    claude: [...DEFAULT_MODELS.claude],
    codex: [...DEFAULT_MODELS.codex],
    cursor: [...DEFAULT_MODELS.cursor],
    copilot: [...DEFAULT_MODELS.copilot],
    ollama: [...DEFAULT_MODELS.ollama]
  }

  // codex: surface the user's actual configured model first.
  const codexModel = codexConfiguredModel()
  if (codexModel) models.codex = mergeUnique([codexModel], models.codex)

  // cursor: live account model list when cursor-agent is reachable.
  const cursorLive = await listCursorModels()
  if (cursorLive) models.cursor = mergeUnique(cursorLive, models.cursor)

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
