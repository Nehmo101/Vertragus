Deutsch | [English](PLAN-LANDSCAPE.md)

# Landscape-Umsetzungsplan

Stand: 26. August 2026. Kein Programcode in dieser Änderung.

Setzt die Lücken aus [`RESEARCH-LANDSCAPE.md`](RESEARCH-LANDSCAPE.md)
als **Single-Topic-PRs** um, in **parallelen Wellen**, solange die
Dateien nicht kollidieren. C7-Reseat bleibt die Spec in
[`MODEL-PROVIDER-SWITCH.md`](MODEL-PROVIDER-SWITCH.md). Doktrin bleibt
[`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md): ein Host-Pfad, kein
zweites Produkt, kein Autodelete, kein Peer-to-Peer, kein RAG, kein
Cloud-Runner.

Größen sind **S / M / L** (Dateien und Risiko), keine Kalenderzeit.

---

## Doktrin für jeden Track

- Neue Kraft ist ein **Host-Tool, Event, IPC-Verb oder eine
  Panel-Oberfläche** in der bestehenden Schleife — kein
  Kanban-Produkt, keine DAG-Engine, kein zweiter MCP-Server.
- Host-Wahrheit vor Agenten-Prosa. Diffs kommen aus Git gegen das
  Agent-Worktree (`inspectWorktree.ts`), nie aus dem PTY-Tail.
- Kommentare, Steering und Antworten nutzen `user_message` /
  `send_to_agent` / `answer_question`. Kein zweites Gehirn, das in
  eine geparkte Orchestrator-TUI tippt.
- Worker committen weiter nie; Promote bleibt ein Klick des Menschen
  (oder die bestehenden Automation-Host-Merges). Setup-Skripte dürfen
  Deps installieren; sie dürfen nicht `git commit` / `git push`.
- Fail-loud bei Contract-Fehlern, fail-soft bei Disk-/Netz-Extras
  (dieselbe Form wie `journal.ts` / `pullRequest.ts`).
- Tests sitzen neben dem Subject. Der Coverage-Ratchet geht nicht
  runter.
- User-facing Strings: Renderer-i18next **en+de**,
  `src/shared/mainMessages.ts`, `src/remoteClient/i18n.ts` — immer
  beide Locales. Docs: englisches Canonical plus deutsches Twin.

---

## Wie Tracks parallel laufen

Der Flaschenhals sind nicht „zu viele Ideen". Es sind **vier Hot-
Files**. Zwei PRs, die dieselbe anfassen, kämpfen, auch wenn die
Features unabhängig sind.

| Hot-File | Warum es serialisiert |
| --- | --- |
| `src/main/workspace/Workspace.ts` | Lifecycle, Summary, Succession, Inspect, PR, Budget |
| `src/main/agents/spawn.ts` | Argv, Env, MCP-Attach, Yolo-Flags. |
| `src/shared/schema/events.ts` | Discriminated Union + exhaustiver Test |
| `src/shared/schema/profile.ts` | Automation, Caps, jede per-Profil-Setting |

**Regel:** höchstens **ein offenes PR** mutiert jedes Hot-File. Logik
in ein **Leaf-Modul** schieben, damit Welle 1 `Workspace.ts` nicht
braucht.

### Datei-Besitz

Jeder Track unten nennt ein **Primary-Verzeichnis**. Andere Tracks
dürfen diese Dateien lesen, nicht umschreiben, bis das besitzende PR
gelandet ist.

### i18n- und IPC-Merge-Regeln

- Renderer-Keys leben in Namespaces: `review.*`, `notify.*`,
  `readiness.*`, `sandbox.*`, `ci.*`, `reseat.*`. Parallele PRs mergen
  dann `en.json` / `de.json` ohne überlappende Keys.
- Neues IPC: den Channel in `appIpc.ts` **und** `preload/index.ts` im
  selben PR (`ipc.test.ts` prüft, dass die Listen gleich sind).
- Neues Remote-Verb: nur wenn das Phone etwas **tun** muss, das die
  Summary nicht zeigen kann. Read-only Inspect ist der eine Kandidat;
  das ist Welle 2 und optional. Kein `stop_agent` / `focus_agent`.

### Was seriell bleibt

- Zwei Preset-PRs, die beide `presets.ts` editieren (Lane P ist eine
  Queue).
- Alles, was Spawn wrappt (`W3` Port-Env, dann `S1` Sandbox).
- W3 / S1 / P2 serialisieren auf `spawn.ts`, nachdem der Pi-Wrap-Exit
  gelandet ist ([`PLAN-PI-EXIT.md`](PLAN-PI-EXIT.md)).
- C7 M1–M3 (eine State Machine). M2 (Panel-Picker) kann sich mit M3-
  *Vorbereitung* überlappen, darf aber nicht vor M1 landen.
- Event-Kind-Ergänzungen: im PR landen, das das Event **zuerst
  produziert**, nicht als leerer Schema-Dump.

---

## Wellenkarte

```
Wave 1 — four PRs in parallel (leaf modules)
  N1 notifications          settings + new notify.ts
  P1 extra presets          presets.ts queue (Gemini, then OpenCode, …)
  R1 panel review           IPC → existing inspectAgent
  W1 gitignored copy        worktree.ts + profile preservePatterns
        │
        ▼
Wave 2 — after R1 and W1 (W2/W3 own Workspace.ts + spawn.ts)
  R2 line comments          user_message (no new event)
  R3 phone inspect          optional 8th gateway verb
  W2 setup/run scripts      profile + createWorktreeFor
  W3 port block             spawn env; same PR as W2 preferred
  T1 process snapshot       new processStats.ts + summary fields
        │
        ▼
Wave 3 — after spawn.ts and Workspace.ts are free
  S1 sandbox opt-in         spawn wrapper; SECURITY twins
  C1 CI on host PRs         pullRequest.ts + ci_status event
  C7 reseat M1→M5           existing spec
  P2 ACP attach dialect     attach.ts; not a seventh provider
  V1 preview URL on card    needs W3
        │
        ▼
Wave 4 — medium fit, only once review + readiness exist
  Issue-body playbook seed, skills sync, worktree pool, A/B via R1
```

N1 und P1 blocken Welle 2 nicht. Wenn sie rutschen, Welle 2 trotzdem
starten.

---

## Welle 1 — vier unabhängige PRs

Ziel: Operator-Ping, breitere CLIs, ein menschlicher Diff, lauffähige
Worktrees. **Keines dieser PRs editiert `Workspace.ts` oder
`events.ts`.**

### N1 — Notifications

**Größe S. Lane: Operator. Dateien: neues `src/main/notify.ts`,
`store/settings.ts`, Settings-UI, Remote `haptics.ts`.**

Auf `WorkspaceDirectory.onChange` / die Events hören, die die Card
schon sieht. Eine Electron-`Notification` (und den bestehenden Phone-
Haptic) feuern auf `ask_user` / `agent_question`, `agent_done`,
`orchestrator_idle`. Opt-in in den Settings; Default **an** für Fragen,
**an** für Idle, **aus** für jedes `agent_done` (das ist laut).

Keine neuen Event-Kinds. Die TUI nicht parsen.

**Fertig wenn:** ein geparktes `ask_user` eine Desktop-Notification
mit Workspace-Namen erzeugt, und ein Klick darauf das Panel fokussiert;
Tests decken quiet/disabled und fehlende Notification-Permission.

### P1 — Extra-Presets

**Größe S pro CLI (M, wenn der Attach-Dialekt neu ist). Lane:
Provider. Dateien: `src/main/providers/presets.ts`,
`presetVerification.ts`, Matrix-Tests. Queue, nicht forken.**

**Eine verifizierte CLI pro PR**: Gemini CLI, dann OpenCode, dann Amp
/ Copilot CLI / Droid / Qwen Code, sobald sie geprobt sind. Custom
Provider gibt es schon; ein Preset ist Coverage, keine Architektur. Pi
bleibt ein Wrap, keine siebte Id
([`HANDBOOK-HARNESS.md`](HANDBOOK-HARNESS.md)).

Unbekannte Flags killen einen Launch — Argv nicht raten.
`PRESET_VERIFICATION` muss die wirklich geprobte CLI-Version nennen.

**Fertig wenn:** die First-Run-Card den neuen Punkt zeigt, Spawn-Tests
das Preset decken, und eine Live-Probe-Notiz im PR steht (oder „not
installed").

ACP ist **nicht** dieser Track — das ist P2.

### R1 — Panel-Review

**Größe M. Lane: Operator. Dateien: `appIpc.ts` + Preload
(`workspaces:inspect`), `inspectWorktree.ts` (UI-großer Unified Diff,
unveränderte MCP-Caps), `WorkspaceCard` / kleines `AgentDiff`-Pane,
Renderer-i18n.**

`Workspace.inspectAgent` existiert schon. Das Panel kann es nicht
aufrufen. Ein **Request/Response**-IPC exponieren (noch kein Gateway-
Verb), das Host-Git-Fakten für einen Agenten liefert: Status, geänderte
Dateien, gescopter Diff. Übergroße Bodies wie beim MCP spillen.

Ein Zeilenkommentar in dieser Welle ist ein Composer-Prefill
`path:line — text`, gesendet über bestehendes `workspaces:userMessage`
mit dem Agenten als Adressat. Die volle Kommentar-UX ist R2.

Keinen Monaco-Editor einbetten, wenn eine Dateiliste + Unified Diff
reicht. `read_output` nicht als Diff behandeln.

**Fertig wenn:** das Öffnen einer Worker-Zeile den Host-Diff dieses
Worktrees zeigt, ein Kommentar `user_message` sendet (in Tests
asserted), und das MCP-Verhalten von `inspect_agent` unverändert bleibt
(Cap + Spill).

### W1 — Gitignorierte Dateien kopieren

**Größe S. Lane: Isolation. Dateien: `src/main/agents/worktree.ts`,
`schema/profile.ts` `preservePatterns`, Profil-Editor.**

Nach `git worktree add` ausgewählte **bereits gitignorierte** Dateien
aus dem Repo-Checkout in das neue Worktree kopieren (`.env`,
`.env.local`, plus Profil-Patterns). Tracked Files nicht kopieren. Nie
committen. Default-Liste klein; der User erweitert sie.

Den Copy **in `createWorktree`** halten, damit `Workspace.ts` sich
nicht ändert. Autodelete bleibt verboten.

**Fertig wenn:** ein Worktree aus einem Repo mit `.env` (gitignored)
diese Datei enthält; ein tracked `README.md` wird nicht per Copy
dupliziert; Unit-Tests decken fehlende Quelle (skip) und Path-Escape
(refuse).

---

## Welle 2 — Operator und Isolation vertiefen

Starten, wenn R1 und W1 auf `main` sind. **W2+W3 ist das eine PR, das
in dieser Welle `Workspace.ts` und `spawn.ts` editieren darf.**

### R2 — Inline-Kommentare

**Größe S. Nach R1. Dateien: nur AgentDiff-Pane + i18n.**

Klick auf eine Diff-Zeile → Composer auf diesen Agenten, Prefix
`file:line`. Zustellung bleibt `user_message`. Optional später ein
quiet `review_comment`-Event, wenn der Orchestrator es im Journal sehen
muss; v1 braucht das nicht.

### R3 — Phone-Review (optionales Verb)

**Größe S–M. Nach R1. Dateien: `protocol.ts`, `gateway.ts`, Remote-
Client.**

Produktentscheidung: entweder (a) ein **gecapptes** `changedFiles` +
`diffStat` auf `WorkspaceAgentSummary` (kein neues Verb, winzige
`Workspace.ts`-Summary-Änderung — **warten, bis W2 gelandet ist**),
oder (b) read-only `workspaces:inspect` als achtes Gateway-Verb, derselbe
Host-Pfad wie R1.

(a) bevorzugen, wenn das Phone nur „was hat sich geändert" braucht;
(b) wenn das Phone eine Datei öffnen muss. Nicht alle `APP_CHANNELS`
spiegeln.

### W2 — Setup- und Run-Skripte

**Größe M. Nach W1. Dateien: `profile.ts`, Profil-Editor,
`Workspace.createWorktreeFor`, ggf. `worktree.ts`.**

Pro Profil `scripts.setup` (nach Worktree-Create: `pnpm install`,
Symlinks) und `scripts.run` (User-Klick auf Run, nicht auto beim
Spawn). `scripts.archive` ist **kein** Autodelete des Worktrees; es
darf einen gebundenen Port oder ein Docker-Compose-Projekt freigeben,
das das Setup gestartet hat.

Kein Shell-String aus Agent-Namen: `execFile` + Argv, cwd = das
Worktree. Fail-soft: ein fehlgeschlagenes Setup ist eine Card-Warnung,
der Agent startet trotzdem (die CLI kann retryen). Setup darf nicht
git-schreiben.

### W3 — Port-Block

**Größe S. Dasselbe PR wie W2.**

Einen stabilen Port-Range pro Agent vergeben (Hash von `agentId` nach
3100–3999, oder ein Host-Allocator). `VERTRAGUS_PORT` /
`VERTRAGUS_PORT_END` in `buildAgentEnv` exportieren. Dokumentieren,
dass App-Configs sie lesen sollen. Kollision mit einem menschlichen
Prozess: überspringen und den nächsten freien Port nehmen, auf der
Agent-Summary festhalten.

### T1 — Prozess-Snapshot

**Größe S–M. Parallel zu R2. Dateien: neues
`src/main/agents/processStats.ts` (pid → RSS, offene Listen-Ports).
Summary-Felder auf der Agent-Zeile — auf W2 warten, wenn das
`Workspace.ts` heißt, sonst IPC wie R1.**

`/proc` lesen (Linux) / best-effort anderswo. Nie Token-Zahlen
erfinden. Wenn eine CLI eine Usage-Datei schreibt, die wir schon
kennen, als „vendor-admitted" zeigen. Wall-Clock `maxRuntimeMin`
bleibt das Budget-Gate.

abtop bleibt ein ergänzendes TUI; das hier ist der In-Panel-Snapshot.

**Fertig wenn:** die Card RSS + Listen-Port für einen lebenden Agenten
zeigen kann, ohne `await_events` zu wecken.

---

## Welle 3 — Safety, Reseat, CI, ACP

Starten, wenn W2/W3 `spawn.ts` und `Workspace.ts` freigegeben haben.
Diese vier können **parallel** laufen, wenn sie bei ihren Dateien
bleiben:

| Track | Darf editieren | Darf nicht editieren |
| --- | --- | --- |
| S1 Sandbox | `spawn.ts`, `agentPolicy`, `SECURITY.md` | `Workspace.ts` (Policy nur beim Spawn lesen) |
| C1 CI | `pullRequest.ts`, `events.ts` (`ci_status`), `Workspace.ts` PR-Poller | `spawn.ts` |
| C7 Reseat | `Workspace.ts`, `toolsOrchestrator.ts`, Handoff, Events | `pullRequest.ts` |
| P2 ACP | `attach.ts`, `provider.ts` `mcp.kind`, Spawn-MCP-Args | `Workspace.ts` |

**C1 und C7 wollen beide `Workspace.ts` und `events.ts`.** Reihenfolge:
zuerst **C1** landen (kleiner, additiver Poller), dann **C7 M1**. S1
und P2 warten nicht.

### S1 — Sandbox opt-in

**Größe L. Linux zuerst.** Opt-in in den Settings (default aus). Den
Agent-Prozess wrappen (bubblewrap / landlock auf Linux; „partial" auf
Windows/macOS dokumentieren). An Helper vererben. Fail-closed: wenn die
Sandbox nicht startet, Spawn verweigern statt auf Host-YOLO zu fallen.

YOLO in einer Sandbox ist eine andere Bedrohung als YOLO auf dem Host —
[`../SECURITY.md`](../SECURITY.md)-Twins aktualisieren. In v1 keine
Container behaupten (Docker à la Sculptor ist ein späteres optionales
Backend, nicht dieser Track).

### C1 — CI auf Host-PRs

**Größe M.** Nachdem `automation.autoPr` einen PR geöffnet hat,
`gh pr checks` im Intervall pollen (dieselben `execFile` + Timeout-
Regeln wie `pullRequest.ts`). `ci_status` pushen (quiet solange
pending, wecken bei Rot/Grün). Card-Badge neben der bestehenden PR-
Zeile. Kein CI-Babysitter in v1 — das ist ein Playbook auf einem roten
Event, keine neue Schleife.

### C7 — Reseat (M1–M5)

**Größe L gesamt; M1 ist S.**
[`MODEL-PROVIDER-SWITCH.md`](MODEL-PROVIDER-SWITCH.md) §12 folgen:

- M1 Root `successor{providerId, model, effort}` + Preflight
- M2 Panel-Picker auf Replace orchestrator (parallelisierbar mit M3-
  *Code*, sobald M1 auf main ist)
- M3 `reseat_agent` (die große Worker-State-Machine)
- M4 In-Session-`/model` (optional für immer)
- M5 `meta.json`-Seat für Resume

M3 nicht starten, solange C1 noch `Workspace.ts` besitzt.

### P2 — ACP-Dialekt

**Größe M.** Neues `mcp.kind: 'acp'` (JSON-RPC stdio) neben claude-json
/ Codex `-c` / Project-Files. Nur für CLIs, die ACP sprechen. Sentinel
bleibt für alle anderen. Das ist ein Attach-Dialekt, keine Provider-Id.

### V1 — Preview-URL

**Größe S. Nach W3.** `previewUrl` (`http://127.0.0.1:${port}`) auf die
Agent-Summary. Die Card verlinkt sie; `/browser` bleibt das Worker-Tool
zum Fahren des User-Chromiums. Keinen Browser in das Panel einbetten.

---

## Welle 4 — mittlere Passung, wenn die Schleife reviewbar ist

Erst nach R1 + W2. Jedes ist sein eigenes PR. Keines ist ein zweites
Produkt.

- **Issue-Body-Seed:** ein Playbook (oder Paste in das Play-Goal), das
  `workspaces:start {goal}` aus einer GitHub-Issue-URL füllt, die der
  User angegeben hat. Kein Linear/Jira-Sync, kein Auto-Spawn pro Ticket.
- **Agent-Skills-Sync:** optionales Profil-Extra, das `~/.agentskills/`
  in Vendor-Dirs kopiert. Bequemlichkeit, kein RAG.
- **Worktree-Pool:** Reserves à la Emdash. Lohnt erst nach W2 (ein
  gepooltes leeres Tree fehlt trotzdem `node_modules`).
- **Same-Task-A/B:** zwei `start_agent`s + R1, um einen Sieger zu
  wählen. Keine DAG-Engine.
- **Headless-Play:** `VERTRAGUS_DEV_RUN` als CI-Pfad dokumentieren;
  keine Cloud-Flotte wachsen.

---

## Außerhalb des Scopes (Erinnerungen)

Aus dem Handbuch, damit ein Nachbar-Feature kein Track wird:

- Peer-to-Peer-Mailboxes (Claude Agent Teams)
- Kanban / DAG / Cloud-Runner als Produkt
- Autodelete von Worktrees (Pane)
- Orchestrator, der Git, Tests oder Push selbst fährt
- Vendor-TUIs parsen
- Signing/Notarization als Landscape-Track (siehe `SIGNING.md` — eine
  Kostenentscheidung, kein fehlendes ADE-Feature)

---

## PR-Checkliste

Jedes Track-PR:

- [ ] Single Topic; Handbuch-Track-Id in der Description (`N1`, `R1`, …)
- [ ] `pnpm run ci` grün
- [ ] Tests neben dem Subject; keine skipped Tests; Ratchet unverändert
      oder hoch
- [ ] i18n beide Locales in der richtigen Schicht; namespaced Keys
- [ ] Docs-Twins, wenn ein Canonical-Doc geändert wurde
- [ ] Hot-File-Regel: dieses PR ist der einzige offene Mutator jeder
      Datei, die es in der Tabelle oben anfasst
- [ ] Kein neues Remote-Verb, außer dies *ist* R3
- [ ] Kein Autodelete, kein zweites MCP, kein Orchestrator-Git
