/**
 * Which CLI version each built-in preset was last verified against.
 *
 * Deliberately NOT a field of `providerConfigSchema`: verification is a fact
 * about the shipped preset, not a property of a provider a user may edit or
 * define — a custom provider has no "verified against" and must not be asked to
 * invent one. Keeping the map beside the schema types (and re-exported from
 * `src/main/providers/presets.ts`) lets both processes read it: the main
 * process for tooling like `scripts/provider-matrix.mjs`'s drift test, the
 * renderer for the provider editor's drift hint — which is why this lives in
 * `src/shared` and not in `src/main` (the renderer cannot import `@main/*`).
 *
 * The versions come from the verification notes already in the source: the
 * attach layer was verified against codex-cli 0.144.6 and kimi 0.34.0
 * (`src/main/mcp/attach.ts`), the Cursor launch/seed behaviour against
 * cursor-agent 2026.08.11 (`presets.ts`, `interactiveReady.ts`), and Ollama's
 * `--nowordwrap` against ollama 0.30.11 (`presets.ts`). Claude Code and Grok
 * Build carry no version note in those comments, so their entries record the
 * versions current at the time this map was seeded.
 *
 * A mismatch between this map and the installed CLI is a HINT, never an error:
 * a newer CLI usually keeps its flags, and blocking a launch on a version
 * string would be guessing. The weekly provider matrix workflow
 * (`.github/workflows/provider-matrix.yml`) is what turns real drift into a
 * report.
 */
import type { ProviderPresetId } from './schema/provider'

export interface PresetVerification {
  /** The CLI version the preset's flags were verified against. */
  cliVersion: string
  /** ISO date (YYYY-MM-DD) of that verification. */
  verifiedAt: string
}

export const PRESET_VERIFICATION: Record<ProviderPresetId, PresetVerification> = {
  // No version named in the verification comments — the install observed via
  // `claude --version` when this map was seeded.
  claude: { cliVersion: '2.1.238', verifiedAt: '2026-08-21' },
  // src/main/mcp/attach.ts: "Verified against codex-cli 0.144.6 on this machine".
  codex: { cliVersion: '0.144.6', verifiedAt: '2026-08-11' },
  // src/main/mcp/attach.ts: "Verified against kimi 0.34.0".
  kimi: { cliVersion: '0.34.0', verifiedAt: '2026-08-11' },
  // presets.ts / interactiveReady.ts: measured against cursor-agent 2026.08.11.
  cursor: { cliVersion: '2026.08.11', verifiedAt: '2026-08-11' },
  // No version named in the verification comments — current install at seeding.
  grok: { cliVersion: '0.0.34', verifiedAt: '2026-08-21' },
  // presets.ts: "--nowordwrap (verified ollama 0.30.11)".
  ollama: { cliVersion: '0.30.11', verifiedAt: '2026-08-11' }
}
