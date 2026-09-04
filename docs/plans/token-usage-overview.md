# Token usage per agent in the workspace overview

Status: design, 5 September 2026. Nothing below is implemented yet.
On-disk formats were verified by a scout on this machine against
claude 2.1.261, codex 0.153.3, grok 1.0.13 and cursor-agent 2026.08.11
(kimi and ollama not installed).

User request (verbatim, German): *"In der Workspace Übersicht (Button
Übersicht öffnen) möchte ich sehen wieviele Tokens ein Agent verbraucht hat
sobald er fertig ist."* — In the overview window
(`src/renderer/src/timeline/TimelineApp.tsx`, which reuses
`src/renderer/src/panel/WorkspaceCard.tsx`) show, per agent, how many tokens it
consumed once it is finished.

Doctrine that binds this plan (`docs/HANDBOOK-HARNESS.md` E4/E5,
`docs/PLAN-INTAKE-ARCHIVE.md` status table): **no guessed token counters**.
The host shows only what the CLI itself recorded on disk. A provider with no
recorded source shows nothing — no estimate, no scrollback heuristic, no
pricing. The number never drives any host decision (budget stays a wall
clock, succession stays self-declared).

---

## 1. Decision summary

| # | Decision | One-line reason |
| --- | --- | --- |
| D1 | One shared shape `TokenUsage`, a discriminated union on `kind`: `consumption { input, output, cacheRead?, cacheWrite?, total }` and `context { used, window? }`, in `src/shared/schema/events.ts`; optional `tokenUsage` on `agent_done`, `agent_stopped`, `agent_exited`, on `AgentSummary` (host row) and on `WorkspaceAgentSummary` (panel row). Per agent lifetime, cumulative — the CLI session logs are cumulative by construction. | Events already carry host-truth worktree facts on `agent_done`; a sibling field rides every existing pipe (queue, journal, timeline, archive, phone) for free. The discriminator exists so a context-window number (Grok) can never be painted as consumption. |
| D2 | Host reads the number at `report_done` (before the event is pushed, awaited next to `snapshotDone`, fail-soft), again at `stop_agent` (before the kill), and at process exit attaches the cached value and refreshes asynchronously. The orchestrator row gets a number only after its process exited (same exit path); it is never polled while alive. | "Finished" is `report_done`; stop/exit make the last number final; polling a growing multi-MB file on every change tick is the one thing that must not happen. |
| D3 | The provider declares a **usage source** as data: `usageSource` on `providerConfigSchema` (`src/shared/schema/provider.ts`), a discriminated union by dialect (`claude-jsonl`, `codex-rollout`, `grok-session`), optional per preset. The reader lives in a new module `src/main/providers/usage.ts`; `Workspace.ts` only hands it `{ source, cwd, sessionId, startedAt }`. | Same pattern as `mcp.kind` / `modelDiscovery.kind`: a dialect is data on the provider, main maps kind → reader, a custom Claude-compatible CLI opts in without a release, an undeclared source means "show nothing". |
| D4 | The **agent's own id is the CLI session id**. `Workspace.newId` is `randomUUID` in production (`Workspace.ts` L596), so `agentId` is a valid UUID; the launch layer emits `[usageSource.sessionIdArg, sessionId]` when the dialect declares the flag (`claude --session-id`, `grok --session-id`). Codex has no launch pin, so its reader matches by the recorded `session_meta.cwd` plus start time. | Exact file match beats a heuristic, and the journal already carries the agent id, so the session file is findable post-mortem from `events.jsonl` alone. No new id, no new record field, deterministic in tests (`sequentialIds`). |
| D5 | Grok is declared with `kind: 'context'`: its session log records context-window occupancy only, no input/output split. The card paints it with a distinct label ("48k context") and a tooltip that says it is occupancy, never consumption. | It is a real CLI-recorded number, not a guess, and the discriminator makes the honest label mandatory; leaving it undefined would hide recorded truth for no gain. |
| D6 | UI: overview only. `WorkspaceCard` gets a `showUsage?: boolean` prop; `TimelineApp` passes it; the panel does not. Rendered iff `agent.tokenUsage` is present — presence is the state, no separate "finished" check. The journal line "X finished" appends the count. | The panel is the glanceable list; the overview is where the user asked for it. Presence of the field already encodes "a read happened at done/stop/exit". |
| D7 | Persistence rides `events.jsonl` through the existing journal tap — zero extra storage. Resume/archive keep it because `agentEventSchema` gains the field (zod strips unknown keys otherwise). | Adding the field to the schema is the whole persistence story. |
| D8 | `slimAgentsSummary` (the `await_events` row) does **not** opt the field in; `list_agents` shows it as-is. | Per-turn payloads stay lean; a recorded number in a one-off overview is not a guess. |

Accepted trade-off: three small dialect readers instead of a generic
"jsonl + jsonPath" descriptor. Claude needs dedupe by message id and a sum,
Codex needs "last cumulative record wins", Grok reads two small files — a
generic walker would be a fourth, worse parser. The unknown that would flip
D5: if the product owner decides occupancy must not appear at all, drop the
grok preset's `usageSource` and the `context` variant stays unused but
harmless.

---

## 2. Data flow

```
CLI writes its own session log
  Claude: ~/.claude/projects/<slug>/<agentId>.jsonl          (pinned via --session-id)
  Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl (matched by session_meta.cwd)
  Grok:   ~/.grok/sessions/<encoded cwd>/<agentId>/{updates.jsonl,signals.json} (pinned)
        │
        │  read on demand only — never polled
        ▼
src/main/providers/usage.ts   readTokenUsage({ source, cwd, sessionId, startedAt }) → TokenUsage | undefined
        ▲                                   (fail-soft: any error → undefined)
        │
Workspace.readTokenUsage(agentId)  ── caches on AgentRecord.tokenUsage
   called from:
   • toolsSubagent report_done      → agent_done.tokenUsage      (MCP agents)
   • Workspace.emitAgentDone        → agent_done.tokenUsage      (sentinel agents)
   • Workspace.stopAgent            → cache; toolsOrchestrator stop_agent → agent_stopped.tokenUsage
   • Workspace.handleExit           → agent_exited.tokenUsage (cached) + async refresh
        │
        ├─► EventQueue.push → journal tap (events.jsonl) → resume / archive / RunTimeline
        │                   → timeline listeners (ev:timeline) → TimelineApp journal row
        │
        └─► Workspace.listAgents()[].tokenUsage / Workspace.lastTokenUsage(orchId)
                    → src/main/index.ts WorkspaceSummary.agents[].tokenUsage
                    → ev:workspaces → TimelineApp → WorkspaceCard showUsage → AgentRow
                    → (verbatim) remote gateway → RemoteAgentSummary (declared, not rendered)
```

Timing guarantee: at `report_done` the read is awaited **before** the
`agent_done` push. The push is what fires `WorkspaceManager.onChange`, so the
`ev:workspaces` rebuild that follows already sees the cached value on the row.

---

## 3. Files to change (exact edits)

Core shared files (`src/shared/schema/*`, `src/preload/index.ts`,
`src/main/appIpc.ts`, `src/main/workspace/Workspace.ts`, `src/main/mcp/types.ts`)
are touched only for the additive seams listed here — one optional field or
one optional method each. Argv is composed in `src/main/agents/spawn.ts`
(`buildAgentArgv`), not under `workspace/`.

### 3.1 `src/shared/schema/events.ts`

Add next to `jsonValueSchema`:

```ts
const tokenCount = z.number().int().nonnegative()

/**
 * Token usage as the agent's OWN CLI recorded it (never estimated), cumulative
 * over the agent's process lifetime.
 * - `consumption`: tokens the model processed. `total` is the CLI's own total
 *   when it records one (Codex `total_tokens`), else the sum of the recorded
 *   parts (Claude: input + output + cacheRead + cacheWrite).
 * - `context`: context-window occupancy only (Grok records nothing else).
 *   NOT consumption — the UI must label it as such.
 */
export const tokenUsageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('consumption'),
      input: tokenCount,
      output: tokenCount,
      cacheRead: tokenCount.optional(),
      cacheWrite: tokenCount.optional(),
      total: tokenCount
    })
    .strict(),
  z
    .object({
      kind: z.literal('context'),
      used: tokenCount,
      /** The model's window size when the CLI recorded it. */
      window: tokenCount.optional()
    })
    .strict()
])
export type TokenUsage = z.infer<typeof tokenUsageSchema>
```

Add `tokenUsage: tokenUsageSchema.optional()` to `agentDonePayload`,
`agentStoppedPayload` and `agentExitedPayload` (doc comment: "Host-read from the
CLI's own session log at report/stop/exit time; absent when the provider
declares no usage source or the read failed."). No envelope change.

### 3.2 `src/shared/schema/provider.ts`

Add after `modelDiscoverySchema`:

```ts
/**
 * Where the CLI records its own token usage on disk. Absent = the host shows
 * no number for agents on this provider (never an estimate).
 * - `claude-jsonl`: `<dir>/<cwd-slug>/<sessionId>.jsonl`, per-assistant-message
 *   `message.usage`, summed per unique `message.id`. `sessionIdArg` pins the
 *   session id at spawn (the agent's own UUID).
 * - `codex-rollout`: `<dir>/YYYY/MM/DD/rollout-*.jsonl`; the last
 *   `token_usage_record.thread_token_usage` wins. No launch pin exists —
 *   matched by the recorded `session_meta.cwd` and the spawn time.
 * - `grok-session`: `<dir>/<encoded cwd>/<sessionId>/` — context-window
 *   occupancy only (`kind: 'context'` on the reading). `sessionIdArg` pins.
 */
export const usageSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('claude-jsonl'),
      /** `~` is expanded to the user's home directory. */
      dir: pathSchema,
      sessionIdArg: flagSchema.optional()
    })
    .strict(),
  z.object({ kind: z.literal('codex-rollout'), dir: pathSchema }).strict(),
  z
    .object({
      kind: z.literal('grok-session'),
      dir: pathSchema,
      sessionIdArg: flagSchema.optional()
    })
    .strict()
])
export type UsageSource = z.infer<typeof usageSourceSchema>

/** Session-pin argument for a launch; empty when the dialect has no flag. */
export function buildSessionIdArgs(
  config: Pick<ProviderConfig, 'usageSource'>,
  sessionId: string | undefined
): string[] {
  const source = config.usageSource
  const flag =
    source && source.kind !== 'codex-rollout' ? source.sessionIdArg : undefined
  return flag && sessionId ? [flag, sessionId] : []
}
```

Add to `providerConfigSchema` after `modelDiscovery`:
`usageSource: usageSourceSchema.optional()`.

### 3.3 `src/main/providers/presets.ts`

- `claude`: `usageSource: { kind: 'claude-jsonl', dir: '~/.claude/projects', sessionIdArg: '--session-id' }`
  (comment: verified claude 2.1.261 — `--session-id <uuid>` pins the file name
  under `~/.claude/projects/<slug>/`).
- `codex`: `usageSource: { kind: 'codex-rollout', dir: '~/.codex/sessions' }`
  (comment: codex 0.153.3 has no launch session-id flag, only `codex resume`).
- `grok`: `usageSource: { kind: 'grok-session', dir: '~/.grok/sessions', sessionIdArg: '--session-id' }`
  (comment: grok 1.0.13 `-s/--session-id <uuid>`; the log records context
  occupancy only, hence `kind: 'context'` readings).
- `kimi`, `cursor`, `ollama`: nothing (see §4).

### 3.4 `src/main/providers/usage.ts` (new)

```ts
export interface UsageProbe {
  source: UsageSource
  /** The agent's worktree — what the CLI recorded as cwd. */
  cwd: string
  /** The agent id, which doubles as the pinned CLI session id. */
  sessionId: string
  /** Epoch ms the agent process started; files older than this are not its. */
  startedAt: number
}
export interface UsageDeps {
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean }>
  homeDir(): string
  now(): number
  platform: NodeJS.Platform
}
export const USAGE_FILE_MAX_BYTES = 64 * 1024 * 1024

/** Never throws. Undefined = no recorded number (missing file, cap, parse failure). */
export async function readTokenUsage(probe: UsageProbe, deps?: Partial<UsageDeps>): Promise<TokenUsage | undefined>

// Pure helpers, exported for tests:
export function claudeProjectSlug(cwd: string): string
export function sumClaudeUsage(jsonl: string): TokenUsage | undefined
export function codexRolloutHeader(jsonl: string): { cwd?: string; sessionId?: string; startedAt?: number }
export function codexUsageFromRollout(jsonl: string): TokenUsage | undefined
export function grokEncodedCwd(cwd: string): string
export function grokContextUsage(files: { signals?: string; updates?: string }): TokenUsage | undefined
export function sameCwd(a: string, b: string, platform: NodeJS.Platform): boolean
```

Behaviour per dialect (formats as verified on disk):

- **`claude-jsonl`** — file `expandHome(dir) / claudeProjectSlug(cwd) / <sessionId>.jsonl`
  (`expandHome` is reused from `@main/providers/discovery`).
  `claudeProjectSlug`: every character outside `[A-Za-z0-9]` becomes `-`,
  **not collapsed** — `C:\Git\Vertragus\.vertragus\worktrees\2da4…` →
  `C--Git-Vertragus--vertragus-worktrees-2da4…` (`:`, `\`, `.` and `/` each
  become one dash). `sumClaudeUsage`: per line `JSON.parse`; skip
  non-objects and lines without `message.usage`; key = `message.id`
  (fallback `uuid`); the same id repeats on split lines, so **dedupe by id,
  last occurrence wins**; then sum `input_tokens` → `input`, `output_tokens`
  → `output`, `cache_read_input_tokens` → `cacheRead`,
  `cache_creation_input_tokens` → `cacheWrite`; `total` = sum of the four.
  Ignore `output_tokens_details.thinking_tokens` (inside `output_tokens`),
  `cache_creation.ephemeral_1h/5m` (inside `cache_creation_input_tokens`) and
  `total_tokens_reminder`. `isSidechain` lines count — they are this agent's
  consumption. Zero assistant lines → undefined (never `0`). The live pointer
  `~/.claude/sessions/<pid>.json` is not used: the pin makes it unnecessary.
  With a pin there is no fallback; a missing file is `undefined`.
- **`codex-rollout`** — candidate dirs `expandHome(dir)/YYYY/MM/DD` for every
  date from `startedAt` minus one day to `now()`; files `rollout-*.jsonl`
  (the trailing UUID in the name is Codex' own session id, unrelated to ours).
  `codexRolloutHeader`: the `session_meta` line's `payload.cwd`,
  `payload.session_id` (or `id`) and `payload.timestamp`. Keep files with
  `sameCwd(cwd, probe.cwd)` and timestamp `>= startedAt - 60_000`; newest
  wins. `codexUsageFromRollout`: the **last** `token_usage_record` line
  (top-level `type` or `payload.type` — copy the real nesting into the
  fixture) whose `thread_token_usage` is present: `input_tokens` → `input`,
  `cached_input_tokens` → `cacheRead`, `cache_write_input_tokens` →
  `cacheWrite`, `output_tokens` → `output`, `total_tokens` → `total`
  (`reasoning_output_tokens` is inside `output_tokens`; `usage` and
  `turn_token_usage` are per call/turn and ignored). No record → undefined.
- **`grok-session`** — dir `expandHome(dir) / grokEncodedCwd(cwd) / <sessionId>`
  where `grokEncodedCwd` is `encodeURIComponent(cwd)` (copy the real
  directory name from this machine into the test to pin the encoding).
  `grokContextUsage`: prefer `signals.json` (`contextTokensUsed` → `used`,
  `contextWindowTokens` → `window`; present only after the session ended);
  else the last `updates.jsonl` line carrying `_meta.totalTokens` → `used`
  (no `window`). Result `{ kind: 'context', … }`. `summary.json` is read only
  to assert `info.cwd` matches (`sameCwd`); mismatch → undefined.
- `sameCwd`: `path.resolve` both, strip trailing separators, case-insensitive
  on `win32`.
- Any `stat` with `size > USAGE_FILE_MAX_BYTES` → undefined (a partial number
  is a guessed number). Any thrown error → undefined; warn once per process via
  `console.warn('[usage] …')`, then stay quiet (same idiom as `journal.ts`).

### 3.5 `src/main/agents/spawn.ts`

- `AgentLaunchInput.sessionId?: string` (doc: "The agent's id, handed to the
  CLI as its session id when the provider's `usageSource` declares a
  `sessionIdArg`; ignored otherwise.").
- In `buildAgentArgv`, directly after `buildEffortArgs(...)`:
  `argv.push(...buildSessionIdArgs(provider, input.sessionId))`.
  Emitted for every launch kind (orchestrator, lead, subagent) — the pin is
  bookkeeping, not a permission.

### 3.6 `src/main/mcp/types.ts`

- `AgentSummary.tokenUsage?: TokenUsage` (import type from `@shared/schema/events`).
- `AgentHost.readTokenUsage?(agentId: string): Promise<TokenUsage | undefined>`
  — optional like `askTimeoutMsFor`; doc: "Read the agent's CLI-recorded usage
  now and cache it; undefined for a provider without a usage source or when the
  read failed. Never throws."
- `slimAgentsSummary`: no change (it names its fields, so the new one is
  excluded by construction). `summarizeAgents` spreads the row, so `list_agents`
  carries it.

### 3.7 `src/main/mcp/testing.ts`

`FakeAgentHost`: `tokenUsages = new Map<string, TokenUsage>()`;
`readTokenUsageCalls: string[]`; `async readTokenUsage(agentId)` pushes the id
and returns `this.tokenUsages.get(agentId)`; an option `usageError?: string`
makes it throw (to prove callers are fail-soft).

### 3.8 `src/main/mcp/toolsSubagent.ts` — `report_done`

After the result validation, before `snapshotDone`:

```ts
const usage = await ctx.host.readTokenUsage?.(agentId).catch(() => undefined)
const usageFields = usage ? { tokenUsage: usage } : {}
```

Spread `...usageFields` into both pushes (`{ ...payload, ...worktreeEventFields(facts), ...usageFields }`
and the catch branch `{ ...payload, ...usageFields }`).

### 3.9 `src/main/mcp/toolsOrchestrator.ts` — `stop_agent`

After `stopped = await ctx.host.stopAgent(agentId)`:

```ts
const usage = stopped ? await ctx.host.readTokenUsage?.(agentId).catch(() => undefined) : undefined
```

and `...(usage ? { tokenUsage: usage } : {})` on the `agent_stopped` payload.
(The host already cached the value during `stopAgent`; this call returns the
cache — see 3.10.)

### 3.10 `src/main/workspace/Workspace.ts`

- Imports: `readTokenUsage` from `@main/providers/usage`, type `TokenUsage`
  from `@shared/schema/events`.
- `AgentRecord.tokenUsage?: TokenUsage` ("last host read; final once the
  process is gone"). No session-id field: `record.agentId` is the session id.
- `WorkspaceDeps`: `readTokenUsage?: typeof readTokenUsage` (tests inject) and
  `onTokenUsageRefreshed?: () => void` (the manager passes `notifyChange`, see
  3.11; absent = no tick, harmless).
- The three spawn sites (`finishLeadStart` ~L1026, `finishStart` ~L1113,
  orchestrator start ~L1944) add `sessionId: record.agentId` to the launch
  input. `buildSessionIdArgs` decides per provider whether it reaches argv.
- New private `probeTokenUsage(record)`: resolves the provider by
  `record.providerId`; returns undefined when `!provider.usageSource`;
  otherwise `await (this.deps.readTokenUsage ?? readTokenUsage)({ source, cwd: record.worktreePath, sessionId: record.agentId, startedAt: record.startedAt })`
  in try/catch → undefined. A defined result is stored on the record; an
  undefined result keeps the previous cache (a transient read failure must not
  erase a real number).
- New public methods:
  ```ts
  /** AgentHost: read now, cache, never throw. Cached value once the process is gone. */
  async readTokenUsage(agentId: string): Promise<TokenUsage | undefined>
  /** Sync cached value — for summaries (orchestrator row included). */
  lastTokenUsage(agentId: string): TokenUsage | undefined
  ```
  Both resolve the orchestrator via `this.orchestratorRecord` as well as
  `this.agents`. `readTokenUsage` returns the cache when
  `record.stopped || record.exit`, else probes.
- `stopAgent`: when `wasRunning`, `await this.readTokenUsage(agentId)` before
  `this.terminate(record)`.
- `handleExit`: on both `orchestrator_exited` and `agent_exited` pushes add
  `...(record.tokenUsage ? { tokenUsage: record.tokenUsage } : {})`; after the
  push schedule `void this.probeTokenUsage(record).then(() => this.deps.onTokenUsageRefreshed?.())`.
  The `record.stopping` early return needs nothing (the stop path already read).
- `emitAgentDone` (sentinel path): `const usage = await this.readTokenUsage(record.agentId)`
  before the snapshot; spread `...(usage ? { tokenUsage: usage } : {})` into both pushes.
- `listAgents()`: live records add `...(record.tokenUsage ? { tokenUsage: record.tokenUsage } : {})`.

### 3.11 `src/main/workspace/WorkspaceManager.ts`

In `startWorkspace`, the `new Workspace(...)` deps object gains
`onTokenUsageRefreshed: () => notifyChange()`.

### 3.12 `src/main/appIpc.ts` and `src/preload/index.ts`

`WorkspaceAgentSummary.tokenUsage?: TokenUsage` in both files (preload imports
the type from `@shared/schema/events`; appIpc already imports `AgentEvent`
from there). Doc: "CLI-recorded usage, present after the agent reported done,
was stopped, or exited. Absent for providers without a usage source."

### 3.13 `src/main/index.ts` — workspace summary rows

- Subagent rows: `...(agent.tokenUsage ? { tokenUsage: agent.tokenUsage } : {})`.
- Orchestrator row: `...(() => { const usage = ws.lastTokenUsage(orchestrator.agentId); return usage ? { tokenUsage: usage } : {} })()`.

### 3.14 `src/shared/remote/protocol.ts`

`RemoteAgentSummary.tokenUsage?: TokenUsage` — the gateway forwards
`directory.list()` verbatim (`src/main/index.ts` `listWorkspaces: () => directory.list()`),
so the wire gains the field whether or not a client draws it; declaring it keeps
the protocol honest. The phone does not render it (out of scope).

### 3.15 Renderer

- `src/renderer/src/lib/formatTokens.ts` (new):
  ```ts
  export function formatTokenCount(count: number, locale: Locale): string
  // < 1_000 → "842"; < 1_000_000 → "12.4k" (de: "12,4k"); else "1.2M" (de: "1,2M").
  // One decimal, trailing ".0" dropped, decimal separator via Intl.NumberFormat(locale).
  export function tokenUsageCount(usage: TokenUsage): number
  // consumption → total; context → used.
  ```
- `src/renderer/src/panel/viewModel.ts`:
  ```ts
  export function agentTokenLabel(t: Translate, locale: Locale, agent: Pick<WorkspaceAgentSummary, 'tokenUsage'>): string | undefined
  // undefined without usage; consumption → t('panel.agentTokens', { count }); context → t('panel.agentContextTokens', { count })
  export function agentTokenTooltip(t: Translate, locale: Locale, usage: TokenUsage): string
  // consumption: join ' · ' of panel.agentTokensInput, panel.agentTokensOutput, and only when defined
  //   panel.agentTokensCacheRead / panel.agentTokensCacheWrite (full numbers via Intl.NumberFormat(locale)).
  // context: panel.agentContextTokensTitle with { used, window: window ?? '—' }.
  ```
- `src/renderer/src/panel/WorkspaceCard.tsx`: `Props.showUsage?: boolean`
  ("Overview window only: paint CLI-recorded token usage on agent rows.");
  `AgentProps.showUsage?: boolean`; in `AgentRow`, after the
  `panel-agent-status` span:
  ```tsx
  {showUsage && agent.tokenUsage ? (
    <span
      className={agent.tokenUsage.kind === 'context' ? 'panel-agent-tokens is-context' : 'panel-agent-tokens'}
      title={agentTokenTooltip(t, activeLocale(i18n.language), agent.tokenUsage)}
    >
      {agentTokenLabel(t, activeLocale(i18n.language), agent)}
    </span>
  ) : null}
  ```
  and `showUsage={showUsage}` on every `<AgentRow>`.
- `src/renderer/src/timeline/TimelineApp.tsx`: `<WorkspaceCard … showUsage />`.
- `src/renderer/src/timeline/formatEvent.ts`: `formatEvent(t, event, locale)`
  gains a `locale: Locale` parameter (`TimelineApp.tsx` passes its `locale`;
  tests pass `'en'`/`'de'`). For `agent_done` with `tokenUsage` the label key
  is `timeline.event.agent_done_tokens` (consumption) or
  `timeline.event.agent_done_context` (context), with interpolation
  `tokens: formatTokenCount(tokenUsageCount(event.tokenUsage), locale)`.
  Other events unchanged.
- `src/renderer/src/panel/panel.css`: after `.panel-agent-status`:
  ```css
  .panel-agent-tokens {
    flex: 0 0 auto;
    margin-left: 6px;
    font: 500 10px var(--font-mono, var(--font-body));
    color: var(--text-3);
    white-space: nowrap;
  }
  .panel-agent-tokens.is-context { font-style: italic; }
  ```
  (If `panel.css.test.ts` enumerates row classes, add the new ones there.)
- `src/renderer/src/i18n/locales/en.json` — `panel`:
  ```json
  "agentTokens": "{{count}} tokens",
  "agentTokensInput": "Input {{count}}",
  "agentTokensOutput": "Output {{count}}",
  "agentTokensCacheRead": "Cache read {{count}}",
  "agentTokensCacheWrite": "Cache written {{count}}",
  "agentContextTokens": "{{count}} context",
  "agentContextTokensTitle": "Context window in use as recorded by the CLI: {{used}} of {{window}} — occupancy, not consumption"
  ```
  `timeline.event`:
  ```json
  "agent_done_tokens": "{{name}} finished · {{tokens}} tokens",
  "agent_done_context": "{{name}} finished · {{tokens}} context"
  ```
- `de.json` — `panel`:
  ```json
  "agentTokens": "{{count}} Tokens",
  "agentTokensInput": "Eingabe {{count}}",
  "agentTokensOutput": "Ausgabe {{count}}",
  "agentTokensCacheRead": "Cache gelesen {{count}}",
  "agentTokensCacheWrite": "Cache geschrieben {{count}}",
  "agentContextTokens": "{{count}} Kontext",
  "agentContextTokensTitle": "Belegtes Kontextfenster laut CLI: {{used}} von {{window}} — Belegung, kein Verbrauch"
  ```
  `timeline.event`:
  ```json
  "agent_done_tokens": "{{name}} fertig · {{tokens}} Tokens",
  "agent_done_context": "{{name}} fertig · {{tokens}} Kontext"
  ```
  The `timeline.event.` prefix is already in `DYNAMIC_KEY_PREFIXES` of
  `i18n.test.ts`; the `panel.*` keys are literal `t('…')` calls, so the
  parity and dead-key guards pass without allowlist edits.
- No `src/shared/mainMessages.ts` change: no main-process user string is added
  (the warn line is a developer log).

### 3.16 `src/main/providers/presets.matrix.test.ts` and `src/main/agents/spawn.test.ts`

Nothing random ever reaches argv: the session id is the caller-supplied
agent id, so no normalization is needed. In the matrix, `build()` passes a
constant `sessionId: 'SESSION'` in every variant; re-record the six Claude and
six Grok inline snapshots — each gains `"--session-id", "SESSION"` directly
after the effort pair (after the model pair in `bare`). Every other preset's
snapshot must stay byte-identical; that is the assertion that no other preset
grew an unverified flag. In `spawn.test.ts` the existing per-preset
`toEqual` argv cases build without `sessionId` and therefore stay unchanged;
add explicit cases for the pair (see §5).

---

## 4. Provider sources

| Preset | Verified source on disk | Session pin | `usageSource` | Reading |
| --- | --- | --- | --- | --- |
| claude 2.1.261 | `~/.claude/projects/<slug>/<sessionId>.jsonl`; slug = cwd with every non-alphanumeric character → `-` (not collapsed); `type:"assistant"` lines, `message.usage {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`; same `message.id` repeats on split lines → dedupe by id, then sum. Ignore `output_tokens_details`, `cache_creation.ephemeral_*`, `total_tokens_reminder`. Live pointer `~/.claude/sessions/<pid>.json` (unused). | `--session-id <uuid>` = agent id | `claude-jsonl` | `consumption` |
| codex 0.153.3 | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl` (not cwd-grouped); `session_meta.payload.{cwd, session_id}`; `token_usage_record` with `usage` (per call), `turn_token_usage`, `thread_token_usage` (session cumulative, last wins): `input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens`. | none (`codex resume` only) → match by `session_meta.cwd` + start time | `codex-rollout` | `consumption` |
| grok 1.0.13 | `~/.grok/sessions/<urlencoded cwd>/<id>/`: `summary.json` (`info.cwd`, `id`), `updates.jsonl` (`_meta.totalTokens`), `signals.json` (`contextTokensUsed`, `contextWindowTokens`; absent while live). Context-window occupancy only; no billed split on disk (OTEL usage export is opt-in, off). | `-s/--session-id <uuid>` = agent id | `grok-session` | `context` (labelled as such) |
| cursor-agent 2026.08.11 | `~/.cursor/projects/<slug>/agent-transcripts/<chatId>/<chatId>.jsonl` carries `{role, message}` only — no usage fields | — | unknown — leave undefined | nothing shown |
| kimi | not installed; docs mention `~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`, unverified | — | unknown — leave undefined (future `kimi-wire` kind once verified) | nothing shown |
| ollama | `ollama run` is a REPL; nothing persisted | — | undefined by design | nothing shown |

Any new dialect is one union member in `usageSourceSchema`, one reader
function, one fixture — nothing else in this plan changes.

Known limitation (preset comment): Claude's `/clear` starts a new session id
inside the same process; tokens after a `/clear` are not in the pinned file.
Vertragus agents are never told to `/clear`.

---

## 5. Tests

Fixtures (new, under `src/main/providers/__fixtures__/`, each copied from a
real file on this machine and trimmed): `claude-session-usage.jsonl`
(5 assistant lines, one `message.id` repeated with growing `output_tokens`,
one `isSidechain` line, one user line, one torn last line),
`codex-rollout-usage.jsonl` (`session_meta`, two `token_usage_record` lines,
one without `thread_token_usage`), `grok-signals.json`, `grok-updates.jsonl`,
`grok-summary.json`.

| File | Cases |
| --- | --- |
| `src/shared/schema/events.test.ts` | `consumption` and `context` readings accepted on `agent_done`, `agent_stopped`, `agent_exited`; a payload without `tokenUsage` still parses (old journals); negative / non-integer values rejected; an extra key inside either variant rejected (strict); unknown `kind` rejected. |
| `src/shared/schema/provider.test.ts` | all three `usageSource` variants parse; unknown kind rejected; `buildSessionIdArgs` emits the pair only for a dialect with `sessionIdArg` and a given id, never for `codex-rollout`; presets round-trip through `providerConfigSchema`. |
| `src/main/providers/presets.test.ts` | claude, codex and grok carry the expected `usageSource`; kimi, cursor and ollama have none. |
| `src/main/providers/presets.matrix.test.ts` | constant `sessionId: 'SESSION'`; Claude and Grok snapshots show `--session-id SESSION`; all other snapshots unchanged. |
| `src/main/agents/spawn.test.ts` | `buildAgentArgv` places the session pair after effort and before yolo; no pair for a provider without `sessionIdArg`; no pair without `input.sessionId`; the pair reaches orchestrator, lead and subagent kinds alike. |
| `src/main/providers/usage.test.ts` (new) | `claudeProjectSlug` on a Windows path (the scout's example, dashes not collapsed) and a POSIX path; `sumClaudeUsage` dedupes by message id (last wins), counts sidechain, skips torn lines, undefined for zero assistant lines, `total` = sum of four; exact path from `sessionId`; missing file → undefined; file over `USAGE_FILE_MAX_BYTES` → undefined; `codexRolloutHeader` / `codexUsageFromRollout` take the last `thread_token_usage` and map `cache_write_input_tokens` → `cacheWrite`; codex matching by cwd (case-insensitive on win32) and start time, newest wins, foreign cwd and older session ignored, scans yesterday's date dir; `grokEncodedCwd` pinned to the real directory name; `grokContextUsage` prefers `signals.json`, falls back to the last `_meta.totalTokens`, yields `kind: 'context'`; `summary.json` cwd mismatch → undefined; `readFile` throwing → undefined and no throw; warn called once. |
| `src/main/workspace/Workspace.test.ts` | every spawn receives `sessionId === agentId` (fake spawn records `input.sessionId`) for orchestrator, lead and worker; a provider without `usageSource` never calls the read dep; `readTokenUsage` passes `{ source, cwd: worktreePath, sessionId: agentId, startedAt }` and caches; a failed read keeps the previous cache; `stopAgent` reads before the kill (call order vs `pty.kill`); `agent_exited` carries the cached value and the post-exit refresh calls `onTokenUsageRefreshed`; sentinel `agent_done` carries usage; `listAgents()` rows carry it; `lastTokenUsage` answers for the orchestrator after `orchestrator_exited`. |
| `src/main/mcp/toolsSubagent.test.ts` | `report_done` attaches `tokenUsage` from the fake host; host `usageError` → event still pushed without it; a host without the method → unchanged behaviour. |
| `src/main/mcp/toolsOrchestrator.test.ts` | `stop_agent` attaches `tokenUsage` to `agent_stopped`; none when the agent was already gone. |
| `src/main/mcp/types.test.ts` | `summarizeAgents` keeps `tokenUsage`; `slimAgentsSummary` drops it. |
| `src/renderer/src/lib/formatTokens.test.ts` (new) | 842 → `842`; 12_400 → `12.4k` / `12,4k`; 1_000 → `1k`; 1_250_000 → `1.3M` / `1,3M`; 0 → `0`; `tokenUsageCount` picks `total` vs `used`. |
| `src/renderer/src/panel/viewModel.test.ts` | `agentTokenLabel` undefined without usage, `tokens` label for consumption, `context` label for context, per locale; `agentTokenTooltip` omits absent cache parts, formats full numbers per locale, and the context tooltip names occupancy. |
| `src/renderer/src/panel/WorkspaceCard.test.ts` | source contains `showUsage && agent.tokenUsage`, `panel-agent-tokens`, `is-context`, `agentTokenTooltip`; `TimelineApp.tsx` source contains `showUsage` on `<WorkspaceCard`; `PanelApp.tsx` does not. |
| `src/renderer/src/timeline/formatEvent.test.ts` | `agent_done` with consumption uses the `_tokens` label containing the compact count; with context the `_context` label; without usage the plain label; de and en. |
| `src/renderer/src/i18n/i18n.test.ts` | unchanged; must stay green (key parity, no dead keys, no German in en). |
| `src/main/remote/gateway.test.ts` | unchanged; the type addition compiles. |

Verification commands: `pnpm run typecheck`, `pnpm run test`, and
`pnpm run test:coverage` must keep the ratchet in `vitest.config.ts`
(statements 62, branches 88, functions 84, lines 62) — the new pure modules
are fully covered by the tests above, so the ratchet moves up, not down.
Manual check on this machine: start a Claude worker, let it `report_done`,
open the overview: the row shows `N tokens` with a breakdown tooltip and the
journal line reads "X finished · N tokens"; `events.jsonl` has `tokenUsage`
on that `agent_done`; `~/.claude/projects/<slug>/<agentId>.jsonl` exists.
Repeat with a Grok worker: the row shows `N context` in italics.

---

## 6. Out of scope

- Any estimate: scrollback parsing, model-based counting, pricing or dollar
  figures. A provider without a recorded source shows nothing.
- Reading usage while an agent is working (no polling; the orchestrator row
  gets a number only once its process is gone).
- Panel card rendering (the compact panel stays as it is; `showUsage` is only
  set by the overview window).
- Phone / remote client rendering (the field travels; drawing it is a later
  slice in `src/remoteClient`).
- Archive views (`RunTimeline`, `archiveViewModel`) showing the persisted
  number from `agent_done` — a natural follow-up, one projection in
  `src/shared/runTimeline.ts`.
- Per-run totals in `meta.json`, retro statistics, or any budget behaviour.
- Kimi and Cursor sources — Cursor records no usage at all; Kimi is added as
  a `kimi-wire` kind once its format is verified on a real install.
- Grok's opt-in OTEL usage export (would give billed numbers, but needs a
  user-global config change, which a launch never makes).

---

## 7. Implementation order for the worker

1. Schemas: 3.1, 3.2 (+ `buildSessionIdArgs`), tests in `events.test.ts` / `provider.test.ts`.
2. Reader: 3.4 with fixtures and `usage.test.ts`.
3. Launch: 3.5, 3.3, then `spawn.test.ts`, `presets.test.ts`, re-record 3.16.
4. Host: 3.6, 3.7, 3.10, 3.11, `Workspace.test.ts`, `types.test.ts`.
5. Tools: 3.8, 3.9 and their tests.
6. Summary pipe: 3.12, 3.13, 3.14.
7. Renderer: 3.15, `formatTokens.test.ts`, `viewModel.test.ts`,
   `WorkspaceCard.test.ts`, `formatEvent.test.ts`; run `i18n.test.ts`.
8. `pnpm run typecheck && pnpm run test:coverage`; manual check from §5.
