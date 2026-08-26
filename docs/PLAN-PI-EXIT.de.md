Deutsch | [English](PLAN-PI-EXIT.md)

# Pi-Wrap-Exit

Stand: 26. August 2026. Kein Programcode in dieser Änderung.

Der Wrap geht. Die **Host-Gewinne**, die er sichtbar gemacht hat,
bleiben als native Vertragus-Pfade — nicht als mitgelieferter
Coding-Agent.

Doktrin bleibt [`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md).
Landscape-Tracks, die Spawn anfassen, warten:
[`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md).

Größen sind **S / M / L** (Dateien und Risiko), keine Kalenderzeit.

---

## These

Pi war nie ein siebter Provider. Es war ein Spawn-Overlay: die Slots
sagten weiter Claude / Cursor / Codex / Kimi / Grok / Ollama, aber der
Prozess war die mitgelieferte `pi`-CLI plus `pi-mcp-adapter`. Dieses
Overlay ist als Experiment abgeschlossen.

Vertragus orchestriert **fremde Agent-CLIs**. Der Wrap wollte eine
Prozessform kaufen und hat gezeigt, welche Probleme tatsächlich
Host-Probleme sind. Die haben (oder behalten) einen Host-Pfad. Das
Overlay — Pakete, Adapter-Lifecycle, Electron-as-node, ConPTY-Workaround,
asarUnpack-Steuer — nicht.

---

## Nicht das

| Ähnlich | Was es wirklich ist |
| --- | --- |
| Pi in Electron nachbauen | Eine First-Party-Coding-Agent-Runtime — Pi als siebter Provider unter anderem Namen |
| Den Wrap „nur für den Fall“ behalten | Ein zweiter Spawn-Pfad mit Packaging-Steuer, standardmäßig aus |
| Pi-Multi-Provider in einen Prozess portieren | Slots *sind* die Multi-Provider-Story; der Prozess ist die CLI des Slots |
| Ollama per Wrap bei MCP halten | Sentinel (`mcp: none`) ist die ehrliche Grenze |
| Vendor-TUIs parsen oder umstylen | Session-Chrome malt schon **Host-Events**; Berechtigungsdialoge bleiben im rohen PTY |
| Ein zweiter MCP-Server für Homogenität | Ein Loopback-`/mcp`; native Attach-Dialekte bleiben pro CLI |

---

## Doktrin

- Ein Host-Pfad pro Anliegen. Nach dem Schnitt gibt es **eine**
  Spawn-Pipeline: `ProviderConfig` → natives CLI-argv → PTY.
- Host-Wahrheit vor Agenten-Prosa. Session-Chrome, Git-Fakten, Fragen
  und Follow-ups laufen nicht über Pi.
- Policy lebt auf dem Host (`yolo` / `ask-user` / `ask-orchestrator`)
  und auf der **nativen** CLI. Pis `--approve` (keine
  Berechtigungsabfragen) war ein Bypass, kein Feature.
- Fail-loud bei Contract-Fehlern. Der Coverage-Ratchet geht nicht
  runter.
- User-facing Strings: Renderer-i18next **en+de**,
  `src/shared/mainMessages.ts` — beide Locales. Docs: englisches
  Canonical plus deutsches Twin.
- Kein Dependabot-Flood für Electron/React als Ersatz der
  Pi-Allow-List. Native CLIs bleiben PATH-Binaries.

---

## Total Wins

Die existieren schon **ohne** Wrap. Der Exit darf sie nicht löschen
oder wieder hinter den Wrap hängen. X1 pinnt sie mit File-Reading-
Guards, bevor X2 das Overlay löscht.

| Gewinn | Wo er lebt | Was der Wrap vorgetäuscht hat |
| --- | --- | --- |
| Eine Session-Ansicht für jede CLI | `cliSurface` Default `session`; `cliSession.ts`, `cliSessionFeed.ts`, `terminal/SessionPane.tsx` | Eine einzige Pi-TUI |
| Erster Turn erst wenn MCP da ist | `Workspace` + `waitForSession`; Greyhound-Overlay | Adapter `MCP_DIRECT_TOOLS=vertragus` |
| Policy auf echten CLIs | D4-Tiers; Cursor **Run Everything** (`--force --sandbox disabled` + `.cursor/cli.json`) | Pi `--approve` (gar keine Prompts) |
| Sentinel-Ehrlichkeit | `isPtyOnly` wenn `mcp.kind === 'none'` (Ollama) | Wrap zwang `isPtyOnly` false, damit Ollama MCP sprach |
| `await_events` lebt | `raisedWindow` aus `provider.mcpToolTimeoutSec` (Claude 600 s) | Adapter `requestTimeoutMs: 600000`, weil der SDK-Default ~60 s ist |
| Treues argv | `needsFaithfulArgs` — mehrzeilige Prompts sterben nicht in cmd.exe | `.pi/APPEND_SYSTEM.md` + `--append-system-prompt` |
| Extra-MCP auf Dialekten, die einen haben | Native Attach; nur Worker | Wrap-Extras auf jedem Slot inklusive Ollama |
| Vendor-TUIs nicht parsen | Handbuch-Non-Goal; Session-Chrome liest Host-Events | (schon nativ) |

Nichts in der Tabelle braucht `@earendil-works/pi-coding-agent` oder
`pi-mcp-adapter`.

---

## Was geht

Das Overlay und alles, das nur existiert, um es zu starten.

**Runtime.** `piHarnessEnabled`, `Workspace.deps.piHarness`,
`harness: 'pi'` am Spawn, `agents/piHarness.ts`, `.pi/mcp.json`,
`.pi/APPEND_SYSTEM.md`, `writePiHarnessMcpConfig`, CJS-Electron-as-node-
Entrypoint / TTY-Polyfill, `MCP_DIRECT_TOOLS`, Windows-`node`-Interpreter-
Sonderfall, `mainMessages.piNeedsNodeOnWindows`.

**Argv / Goal.** Wrap-only positionales erstes Prompt
(`startOrchestrator` markiert ein zugestelltes Goal bei `piHarness`,
auch wenn der native Provider kein Initial-Prompt-argv hat). Nach dem
Schnitt ist Goal-Zustellung wieder **nur** `buildInitialPromptArgs`
oder der PTY-Seed-Handshake.

**Packaging.** Produktionsdeps `@earendil-works/pi-coding-agent` und
`pi-mcp-adapter`; `asarUnpack`-Globs für diese Bäume plus Photon,
`@mariozechner`, `@napi-rs`, `typebox`, `jiti`; `mac.x64ArchFiles:
**/node_modules/**`, falls das nur Pi-Addons abdeckte (koffi,
Clipboard, Keyring); `mac.mergeASARs: false`, falls der Minimatch-
Overflow die ausgepackten Pi-Bäume waren.

**CI / Pin.** `scripts/pi-play-smoke.mjs`, `piPlaySmoke.ts`,
`scripts/piHarnessPin.test.ts`,
`tests/integration/piHarnessMcp.integration.test.ts`, CI-Job-Steps
„Pi Play smoke“, `.github/dependabot.yml` (erlaubt heute nur diese
zwei Pakete — Datei löschen, kein allgemeines npm-Dependabot öffnen).

**UI / i18n.** Settings-Toggle und `settings.piHarness*`-Keys;
Extra-MCP-Hinweis „Mit dem Pi-Wrap werden Extras bei jedem Slot
angebunden, auch Ollama.“

**Docs.** Troubleshooting „Pi-Wrap-Fenster bleibt unter Windows leer“
und „Pi-MCP hängt nie“; CONTRIBUTING-Absatz Pi-Play-Smoke; Handbuch
How-to-run-Pi (H1–H4). Changelog: **Removed** auf dem Umsetzungs-PR,
nicht hier.

Ein übrig gebliebenes `piHarnessEnabled` in der `vertragus-v2.json`
des Users ist harmlos: `readSettings` lädt nur `SETTINGS_KEYS`. Keine
Migration; den Key aus dem Schema zu streichen reicht.

---

## Serialisierung

Hot-Files, die dieser Exit besitzt, bis er landet:

| Datei | Warum |
| --- | --- |
| `src/main/agents/spawn.ts` | Overlay-argv / Env / Pi-CLI-Entrypoint |
| `src/main/mcp/attach.ts` | `.pi/mcp.json`-Dialektblock |
| `src/main/workspace/Workspace.ts` | `piHarness`-Goal / `isPtyOnly`-Bypass |
| `electron-builder.yml` | asarUnpack, mergeASARs, x64ArchFiles |

[`PLAN-LANDSCAPE.md`](PLAN-LANDSCAPE.md) Welle 2 **W3** (Port-Block)
und Welle 3 **S1** (Sandbox) / **P2** (ACP-Attach) warten, bis dieser
Exit landet. Landscape-Welle 1 (N1, P1, R1, W1) kollidiert nicht.

Lieber **ein Umsetzungs-PR** nach diesem Plan (X1-Guards als erste
Commits, dann X2–X4). X2 und X3 als zwei offene PRs kämpfen um
`spawn.ts` und `electron-builder.yml`.

---

## Tracks

### X0 — dieses Dokument (S, landet hier)

Plan + Handbuch-Zeiger + Landscape-Serialisierung + Changelog-Zeile.
Kein Runtime-Change.

### X1 — die Wins pinnen (S)

File-Reading-Guards mit Self-Checks (dieselbe Kultur wie
`scripts/piHarnessPin.test.ts`, invertiert):

- Kein `@earendil-works/pi-coding-agent`, kein `pi-mcp-adapter`, kein
  `@mariozechner/pi-coding-agent` in `package.json`.
- Kein `piHarnessEnabled`, kein `harness: 'pi'`, kein
  `agents/piHarness.ts`.
- `electron-builder.yml` `asarUnpack` listet keine Pi-Bäume.
- Session-Chrome importiert den Wrap nicht; Default-`cliSurface`
  bleibt `session`.
- `isPtyOnly` ist `mcp.kind === 'none'` **ohne** Wrap-Bypass.
- Der erste Turn wartet weiter auf `waitForSession` (der Hold ist
  nicht wrap-gated).

`scripts/piHarnessPin.test.ts` im selben PR wie die Löschung zu
`scripts/piExitGuard.test.ts` invertieren, damit der Pin keinen
halb entfernten Tree grün färbt. Ist X1 ein eigener erster PR,
warten die „Paket fehlt“-Assertions auf X2; X1 pinnt dann nur die
**Wins** (Session, Hold, `isPtyOnly`, `cliSurface`), die heute schon
halten.

### X2 — Runtime-Schnitt (L)

Overlay aus Spawn-Pipeline und Workspace löschen:

- `piHarness.ts` und Tests entfernen; Overlay-Zweige in `spawn.ts` /
  `spawn.test.ts` streichen; einen einzigen `buildAgentArgv`-Pfad
  wiederherstellen.
- Pi-Block aus `attach.ts` (Config-Write, `PI_*`-Konstanten,
  APPEND_SYSTEM-Helfer). `.pi/mcp.json` aus
  `WORKTREE_SECRET_FILES` streichen.
- `Workspace`: `piLaunch()`, Wrap-Goal-argv, Wrap-`isPtyOnly` weg.
- `WorkspaceManager` / `devRun`: `piHarness`-Dep weg.
- Settings / IPC / Preload / Settings-UI / `mainMessages`.
- i18n: `settings.piHarness`-Keys löschen; Extra-MCP-Hinweis kürzen
  (Claude, Codex, Kimi, Cursor — nicht Ollama; kein Wrap-Satz).

Native Dialekte bleiben. Ollama bleibt Sentinel. Extra-MCP bleibt
workers-only auf Dialekten, die attachen.

### X3 — Packaging und CI (M, derselbe PR wie X2)

- Beide Pakete aus `package.json`; Lockfile erneuern.
- `asarUnpack`: `@lydell/node-pty*` behalten; Pi / Photon / Keyring /
  typebox / jiti-Globs streichen, außer eine andere Runtime braucht
  sie noch (im Exit-Guard asserten).
- `mac.mergeASARs: true` versuchen. Overflowt `@electron/universal`
  minimatch weiter an der node-pty-Unpack-Liste, `false` lassen mit
  einem Kommentar, der node-pty nennt, nicht Pi.
- `mac.x64ArchFiles` von `**/node_modules/**` verengen, wenn das
  einzige verbleibende Native-Addon node-pty ist; auf dem macOS-
  Package-Job beweisen.
- Pi-Play-Smoke löschen (Skript, `piPlaySmoke.ts`, CI-Steps,
  `scripts/piPlaySmoke.test.ts`). Panel-Smoke bleibt.
- `.github/dependabot.yml` löschen, wenn sie noch Pi-only ist.

Coverage: nach der Löschung `pnpm run test:coverage`. Fällt der
Ratchet, native Spawn/Attach-Tests für Pfade nachziehen, die nur die
Wrap-Tests abgedeckt haben. **Schwellen nie senken.**

### X4 — Docs und Doktrin (S, derselbe PR wie X2)

- Handbuch: dieser Exit-Abschnitt wird eine kurze „removed“-Notiz +
  Appendix-Zeile **removed**; Non-Goal bleibt „kein Overlay, kein
  First-Party-Agent“.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) / Twin: die zwei Pi-
  Abschnitte streichen; Cursor Run Everything / Smart App Control
  bleiben (das ist natives Cursor).
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) / Twin: Pi-Play-Smoke-Absatz
  streichen.
- Changelog **Removed**: Wrap, Pakete, Setting, Smoke.
- i18n-Extras-Hinweis wie in X2.

---

## Abnahme

- Play startet die native CLI des Slots. Kein `pi`-Prozess, kein
  `.pi/mcp.json`.
- Settings haben keinen Pi-Toggle. Ein alter Store-Key bricht den
  Boot nicht.
- Session-Chrome, First-Turn-Hold, D4-Policy, Cursor Run Everything,
  Sentinel-Ollama, Extra-MCP auf nativen Dialekten — Verhalten
  unverändert gegenüber Wrap-**aus** heute.
- `pnpm run ci` grün. Coverage-Ratchet nicht gesenkt.
- Gepackte App startet weiter Agenten (node-pty unpacked). macOS-
  Universal-Build grün.
- Exit-Guard würde scheitern, kämen Pi-Pakete oder `piHarnessEnabled`
  zurück.
- Handbuch-Non-Goal: kein Spawn-Overlay einer fremden Agent-CLI, keine
  First-Party-Coding-Agent-Runtime.

---

## Datei-Inventar

Löschen (Umsetzungs-PR):

- `src/main/agents/piHarness.ts`, `piHarness.test.ts`
- `src/main/piPlaySmoke.ts`, `piPlaySmoke.test.ts`
- `scripts/pi-play-smoke.mjs`, `piPlaySmoke.test.ts`, `piHarnessPin.test.ts`
- `tests/integration/piHarnessMcp.integration.test.ts`
- `.github/dependabot.yml` (falls noch Pi-only)

Editieren:

- `spawn.ts` / `spawn.test.ts`, `attach.ts` / `attach.test.ts`
- `Workspace.ts` / `Workspace.test.ts`, `WorkspaceManager.ts` / Test
- `settings.ts` / Test, `appIpc.ts` / Test, `preload/index.ts`
- `SettingsApp.tsx`, `en.json`, `de.json`, `mainMessages.ts`
- `worktree.test.ts`, `index.ts`, `devRun.ts`
- `electron-builder.yml`, `package.json`, Lockfile
- `.github/workflows/ci.yml`
- Handbuch-Twins, TROUBLESHOOTING-Twins, CONTRIBUTING-Twins, CHANGELOG-Twins
