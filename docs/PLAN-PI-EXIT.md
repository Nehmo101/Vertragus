English | [Deutsch](PLAN-PI-EXIT.de.md)

# Pi wrap exit

Stand: 26 August 2026. No program code in this change.

The wrap leaves. The **host wins** it made obvious stay, as native
Vertragus paths — not as a bundled coding agent.

Doctrine stays [`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md). Landscape
tracks that touch spawn wait: [`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md).

Sizes are **S / M / L** (files and risk), not calendar time.

---

## Thesis

Pi was never a seventh provider. It was a spawn overlay: slots still
said Claude / Cursor / Codex / Kimi / Grok / Ollama, but the process
was the bundled `pi` CLI plus `pi-mcp-adapter`. That overlay is done
as an experiment.

Vertragus orchestrates **foreign agent CLIs**. The wrap tried to buy
one process shape and taught us which problems are actually host
problems. Those problems already have (or keep) a host path. The
overlay — packages, adapter lifecycle, Electron-as-node, ConPTY
workaround, asarUnpack tax — does not.

---

## Not this

| Lookalike | What it actually is |
| --- | --- |
| Reimplement Pi inside Electron | A first-party coding-agent runtime — Pi as a seventh provider under another name |
| Keep the wrap "just in case" | A second spawn path with a packaging tax, default off |
| Port Pi multi-provider into one process | Slots *are* the multi-provider story; the process is the slot's CLI |
| Give Ollama MCP by keeping the wrap | Sentinel (`mcp: none`) is the honest boundary |
| Parse or reskin vendor TUIs | Session chrome already paints **host events**; permission dialogs stay in the raw PTY |
| A second MCP server for homogeneity | One loopback `/mcp`; native attach dialects stay per CLI |

---

## Doctrine

- One host path per concern. After the cut there is **one** spawn
  pipeline: `ProviderConfig` → native CLI argv → PTY.
- Host truth over agent prose. Session chrome, git facts, questions
  and follow-ups do not go through Pi.
- Policy lives on the host (`yolo` / `ask-user` / `ask-orchestrator`)
  and on the **native** CLI. Pi's `--approve` (no permission prompts)
  was a bypass, not a feature.
- Fail-loud on contract errors. Coverage ratchet does not go down.
- User-facing strings: renderer i18next **en+de**,
  `src/shared/mainMessages.ts` — both locales. Docs: English
  canonical plus German twin.
- Do not add a Dependabot flood for Electron/React to replace the
  Pi-only allow-list. Native CLIs stay PATH binaries.

---

## Total wins

These already exist **off** the wrap. The exit must not delete or
re-gate them. X1 pins them with file-reading guards before X2 deletes
the overlay.

| Win | Where it lives | What the wrap was faking |
| --- | --- | --- |
| One session view for every CLI | `cliSurface` default `session`; `cliSession.ts`, `cliSessionFeed.ts`, `terminal/SessionPane.tsx` | A single Pi TUI |
| First turn held until MCP exists | `Workspace` + `waitForSession`; greyhound overlay | Adapter `MCP_DIRECT_TOOLS=vertragus` |
| Policy on real CLIs | D4 tiers; Cursor **Run Everything** (`--force --sandbox disabled` + `.cursor/cli.json`) | Pi `--approve` (no prompts at all) |
| Sentinel honesty | `isPtyOnly` when `mcp.kind === 'none'` (Ollama) | Wrap forced `isPtyOnly` false so Ollama spoke MCP |
| `await_events` lives | `raisedWindow` from `provider.mcpToolTimeoutSec` (Claude 600 s) | Adapter `requestTimeoutMs: 600000` because the SDK default is ~60 s |
| Faithful argv | `needsFaithfulArgs` — multiline prompts do not die in cmd.exe | `.pi/APPEND_SYSTEM.md` + `--append-system-prompt` |
| Extra MCP on dialects that have one | Native attach; workers only | Wrap extras on every slot including Ollama |
| Do not parse vendor TUIs | Handbook non-goal; session chrome reads host events | (already native) |

Nothing in that table requires `@earendil-works/pi-coding-agent` or
`pi-mcp-adapter`.

---

## What leaves

The overlay and everything that exists only to boot it.

**Runtime.** `piHarnessEnabled`, `Workspace.deps.piHarness`,
`harness: 'pi'` on spawn, `agents/piHarness.ts`, `.pi/mcp.json`,
`.pi/APPEND_SYSTEM.md`, `writePiHarnessMcpConfig`, CJS Electron-as-node
entry / TTY polyfill, `MCP_DIRECT_TOOLS`, Windows `node` interpreter
special case, `mainMessages.piNeedsNodeOnWindows`.

**Argv / goal.** Wrap-only positional first prompt
(`startOrchestrator` records a delivered goal when `piHarness` even
if the native provider has no initial-prompt argv). After the cut,
goal delivery is again **only** `buildInitialPromptArgs` or the PTY
seed handshake.

**Packaging.** Production deps `@earendil-works/pi-coding-agent` and
`pi-mcp-adapter`; `asarUnpack` globs for those trees plus Photon,
`@mariozechner`, `@napi-rs`, `typebox`, `jiti`; `mac.x64ArchFiles:
**/node_modules/**` if it was only covering Pi addons (koffi,
clipboard, keyring); `mac.mergeASARs: false` if the minimatch overflow
was the unpacked Pi trees.

**CI / pin.** `scripts/pi-play-smoke.mjs`, `piPlaySmoke.ts`,
`scripts/piHarnessPin.test.ts`,
`tests/integration/piHarnessMcp.integration.test.ts`, CI job steps
"Pi Play smoke", `.github/dependabot.yml` (today it allow-lists only
those two packages — delete the file, do not open a general npm
Dependabot).

**UI / i18n.** Settings toggle and `settings.piHarness*` keys; extra-MCP
hint sentence "With the Pi wrap on, extras attach for every slot
including Ollama."

**Docs.** Troubleshooting "Pi wrap window is blank on Windows" and
"Pi MCP never attaches"; CONTRIBUTING Pi Play smoke paragraph;
handbook how-to-run-Pi (H1–H4). Changelog: **Removed** on the
implementation PR, not here.

Leftover `piHarnessEnabled` in a user's `vertragus-v2.json` is
harmless: `readSettings` only loads `SETTINGS_KEYS`. Do not add a
migration; dropping the key from the schema is enough.

---

## Serialisation

Hot files this exit owns until it lands:

| File | Why |
| --- | --- |
| `src/main/agents/spawn.ts` | Overlay argv / env / Pi CLI entry |
| `src/main/mcp/attach.ts` | `.pi/mcp.json` dialect block |
| `src/main/workspace/Workspace.ts` | `piHarness` goal / `isPtyOnly` bypass |
| `electron-builder.yml` | asarUnpack, mergeASARs, x64ArchFiles |

[`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md) Wave 2 **W3** (port block) and
Wave 3 **S1** (sandbox) / **P2** (ACP attach) wait until this exit
lands. Landscape Wave 1 (N1, P1, R1, W1) does not collide.

Prefer **one implementation PR** after this plan (X1 guards as its
first commits, then X2–X4). Splitting X2 and X3 across two open PRs
fights over `spawn.ts` and `electron-builder.yml`.

---

## Tracks

### X0 — this document (S, landed here)

Plan + handbook pointer + landscape serialisation + changelog line.
No runtime change.

### X1 — pin the wins (S)

File-reading guards with self-checks (same culture as
`scripts/piHarnessPin.test.ts`, inverted):

- No `@earendil-works/pi-coding-agent`, no `pi-mcp-adapter`, no
  `@mariozechner/pi-coding-agent` in `package.json`.
- No `piHarnessEnabled`, no `harness: 'pi'`, no `agents/piHarness.ts`.
- `electron-builder.yml` `asarUnpack` does not list Pi trees.
- Session chrome does not import the wrap; default `cliSurface` stays
  `session`.
- `isPtyOnly` is `mcp.kind === 'none'` with **no** wrap bypass.
- First turn still waits on `waitForSession` (the hold is not
  wrap-gated).

Invert `scripts/piHarnessPin.test.ts` into `scripts/piExitGuard.test.ts`
in the same PR as the deletion so the pin cannot green a half-removed
tree. If X1 is a separate first PR, the "absent package" assertions
wait until X2; X1 then only pins the **wins** (session, hold,
`isPtyOnly`, `cliSurface`) which already hold today.

### X2 — runtime cut (L)

Delete the overlay from the spawn pipeline and the workspace:

- Remove `piHarness.ts` and its tests; strip `spawn.ts` / `spawn.test.ts`
  overlay branches; restore a single `buildAgentArgv` path.
- Remove the Pi block from `attach.ts` (config write, `PI_*` constants,
  APPEND_SYSTEM helpers). Drop `.pi/mcp.json` from
  `WORKTREE_SECRET_FILES`.
- `Workspace`: drop `piLaunch()`, wrap goal argv, wrap `isPtyOnly`.
- `WorkspaceManager` / `devRun`: drop `piHarness` dep.
- Settings / IPC / preload / Settings UI / `mainMessages`.
- i18n: delete `settings.piHarness` keys; shorten extra-MCP hint
  (Claude, Codex, Kimi, Cursor — not Ollama; no wrap sentence).

Native dialects stay. Ollama stays sentinel. Extra MCP stays
workers-only on dialects that attach.

### X3 — packaging and CI (M, same PR as X2)

- Drop both packages from `package.json`; refresh the lockfile.
- `asarUnpack`: keep `@lydell/node-pty*`; drop Pi / Photon / keyring /
  typebox / jiti globs unless another runtime still needs them
  (assert in the exit guard).
- Try restoring `mac.mergeASARs: true`. If `@electron/universal`
  still overflows minimatch on the node-pty unpack list, leave
  `false` with a comment that names node-pty, not Pi.
- Narrow `mac.x64ArchFiles` from `**/node_modules/**` if the only
  remaining native addon is node-pty; prove on the macOS package job.
- Delete Pi Play smoke (script, `piPlaySmoke.ts`, CI steps,
  `scripts/piPlaySmoke.test.ts`). Panel smoke stays.
- Delete `.github/dependabot.yml` if it is still Pi-only.

Coverage: run `pnpm run test:coverage` after the deletion. If the
ratchet fails, add native spawn/attach tests for paths that only the
wrap tests were covering. **Never lower thresholds.**

### X4 — docs and doctrine (S, same PR as X2)

- Handbook: this exit section becomes a short "removed" note +
  appendix row **removed**; non-goal stays "no overlay, no first-party
  agent".
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) / twin: drop the two Pi
  sections; Cursor Run Everything / Smart App Control stay (those are
  native Cursor).
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) / twin: drop the Pi Play smoke
  paragraph.
- Changelog **Removed**: wrap, packages, setting, smoke.
- i18n extras hint as in X2.

---

## Acceptance

- Play starts the slot's native CLI. No `pi` process, no `.pi/mcp.json`.
- Settings has no Pi toggle. A stale store key does not break boot.
- Session chrome, first-turn hold, D4 policy, Cursor Run Everything,
  sentinel Ollama, extra MCP on native dialects — behaviour unchanged
  from wrap-**off** today.
- `pnpm run ci` green. Coverage ratchet not lowered.
- Packaged app still spawns agents (node-pty unpacked). macOS
  universal build green.
- Exit guard would fail if Pi packages or `piHarnessEnabled` returned.
- Handbook non-goal: no spawn overlay of a foreign agent CLI, no
  first-party coding-agent runtime.

---

## File inventory

Delete (implementation PR):

- `src/main/agents/piHarness.ts`, `piHarness.test.ts`
- `src/main/piPlaySmoke.ts`, `piPlaySmoke.test.ts`
- `scripts/pi-play-smoke.mjs`, `piPlaySmoke.test.ts`, `piHarnessPin.test.ts`
- `tests/integration/piHarnessMcp.integration.test.ts`
- `.github/dependabot.yml` (if still Pi-only)

Edit:

- `spawn.ts` / `spawn.test.ts`, `attach.ts` / `attach.test.ts`
- `Workspace.ts` / `Workspace.test.ts`, `WorkspaceManager.ts` / test
- `settings.ts` / test, `appIpc.ts` / test, `preload/index.ts`
- `SettingsApp.tsx`, `en.json`, `de.json`, `mainMessages.ts`
- `worktree.test.ts`, `index.ts`, `devRun.ts`
- `electron-builder.yml`, `package.json`, lockfile
- `.github/workflows/ci.yml`
- Handbook twins, TROUBLESHOOTING twins, CONTRIBUTING twins, CHANGELOG twins
