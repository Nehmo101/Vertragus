# Vertragus UI-Overhaul: Canvas-First Control Center + Orchestrator-Chat + Freies Voice-Overlay

> Status (2026-07-18): Plan genehmigt, Umsetzung noch offen. Drei Orchestrierungs-Läufe wurden
> abgebrochen — Ursachenanalyse und benötigte Vorbedingungen stehen am Ende dieses Dokuments
> unter [Ausführungs-Blocker](#ausführungs-blocker-stand-2026-07-18).

## Context

Vertragus soll sich wie ein räumliches Control-Center anfühlen, ist aber heute terminal-zentriert: Die Canvas ist nur ein drittes Sub-Layout hinter kryptischen Icons (Default: Tiles), mit dem Orchestrator spricht man ausschließlich über sein rohes xterm-Terminal, und der Voicechat ist eine starre Diktierleiste im Workspace-Header ohne jedes App-Wissen. Ziel: (1) Canvas als Go-To-Ansicht, (2) direkter Chat mit dem Orchestrator in der Canvas, (3) ein frei auf dem Desktop schwebender Voice-Assistent (nicht ans App-Fenster gebunden), der das komplette App-Layout/-Wissen kennt und Aktionen ausführen kann ("starte Profil Vertragus" → neuer Workspace aus dem Profil), plus (4) Umsetzung der UI-Review-Findings.

**Nutzerentscheidungen:** Voice-Architektur = Pipeline STT→LLM-mit-Tools→TTS komplett im Main-Prozess (kein Realtime; Keys bleiben main-only). Umfang = alles inkl. Phase-3-Polish (Command-Palette, A11y, Dark-Theme-Feinschliff).

Stack: Electron (sandboxed, contextIsolation, `window.orca`-Preload-Bridge), React 18 + Zustand, @xyflow/react + dagre (Canvas), plain global CSS mit Cozy-Organic-Tokens (Bronze `--accent:#936c2b`, Verdigris `--sage:#1e5148`, Caprasimo), i18next mit Deutsch als Quellsprache.

## Verifizierte Ausgangslage (tragende Fakten)

- Canvas = Sub-Layout: `src/renderer/src/components/Workspace.tsx:15-19` (LAYOUTS), Switcher :114-128; Default `'tiles'` in `src/renderer/src/store/useAppStore.ts:368`, Persistenz-Resolution :503-508, Setter :848-851 (`ui.workspaceLayout`).
- `CanvasBoard.tsx` (462 Z.): Task-Nodes mit Live-`TerminalPeek`, Trust-Gates, Evidence; Orchestrator-Root-Node; Findings-Notizen (max 8); dagre-LR-Layout in `canvasGraph.ts`; Positionen in `canvasStore.ts` (localStorage `vertragus.canvas.v1`). Canvas nie full-bleed: `.body-row.layout-canvas .orch-panel` (`styles.css:3941-3943`).
- Orchestrator = PTY-Agent; einziger Textkanal `agents.write` → `agent:write` (`src/main/ipc/register.ts:499`, ungegated `ipcMain.on`). Boot-aware `agentManager.seedInteractive(id, prompt)` (`src/main/agents/AgentManager.ts:1349`) + `engine.setGoal` existieren nur main-seitig (genutzt vom Inbox-Transfer `src/main/inbox/transferService.ts`).
- Voice heute: nur Push-to-talk-STT (`VoiceBar.tsx` inline im Workspace-Header + Inbox-Mic; Hook `useInboxSpeech.ts`; Main `InboxSpeechService.ts` → `OpenAITranscriptionProvider.ts`, Key via safeStorage in `src/main/config/secrets.ts`; Provider-Interface swappable in `src/main/voice/types.ts`). Kein TTS/LLM/Kontext, kein `globalShortcut`, keine Command-Abstraktion. Roadmap: `docs/VOICE_INTERFACE_PLAN.md` (lehnt ANSI-Scrollback als TTS-Quelle explizit ab).
- Fenster: Main frameless, NICHT transparent/always-on-top. Popout-Muster `createPaneWindow` (`src/main/windows.ts:294`), `broadcast()` an alle Fenster, `isMainWindowSender()` (`windows.ts:289`) gated privilegierte IPC.
- "Profil als neuer Workspace" existiert end-to-end: `useAppStore.startAll()` (:896-930) → `agents.spawnProfile` → `spawnProfileTeam` (`src/main/agents/spawnProfile.ts`) → `workspaceSessions.start()` (`WorkspaceSessionRegistry.ts`, frische Session pro Aufruf) — aber ohne Goal-Argument.
- `OrchestratorSnapshot` (`src/shared/orchestrator.ts:348-379`): goal, activity, tasks (phase/lastAction/heartbeat/usage), findings, pendingPlan/approvals/permissions, budget — reicher, typisierter Assistenten-Kontext, bereits via `ev:orchestrator` gepusht.

## Architektur-Entscheidungen

| # | Entscheidung |
|---|---|
| D1 | Default-Layout `'canvas'` mit einmaliger Migration (Flag `ui.canvasDefaultApplied`); wer danach explizit Tiles wählt, behält es |
| D2 | Im Canvas-Layout: OrchestratorPanel wird toggelbarer Overlay-Drawer rechts; Sidebar bekommt Collapse-to-Rail (~52px); Workspace-Header wird schlanke Floating-Toolbar → Canvas full-bleed |
| D3 | Terminal-Zugriff aus der Canvas: Bottom-Slide-up-Drawer mit vorhandenem `AgentPane` (Doppelklick auf Node); Tiles/Focus bleiben als Sekundär-Layouts |
| D4 | Chat-Transport: neue gated IPC `orchestrator:send` → `agentManager.seedInteractive` (boot-aware; deckt "gerade gestartet" und "idle" ab) |
| D5 | Antworten NIE aus PTY-ANSI parsen — Thread-Feed aus dem `OrchestratorSnapshot` (activity, goal, pendingPlan, findings) |
| D6 | Voice-Overlay = eigenes transparentes, frameless, always-on-top `BrowserWindow` mit Hash-Route `#/voice` (Muster: `createPaneWindow`), Orb draggable via `-webkit-app-region: drag`, Position persistiert |
| D7 | IPC-Autorisierung: neues `isVoiceWindowSender()`; NUR die neuen `voiceAssistant:*`/`voiceOverlay:*`-Kanäle akzeptieren Voice-Fenster. Alle Aktionen laufen im Main-Prozess-Service — das Overlay ruft nie direkt `agents.write`/`spawnProfile` |
| D8 | Assistent = Pipeline im Main-Prozess: STT (vorhandener Provider) → `/chat/completions` mit Tools (Default `gpt-4o-mini`) → `/audio/speech` TTS (Default `gpt-4o-mini-tts`, abschaltbar). Provider-Interfaces abstrakt halten → Realtime als späterer Upgrade-Pfad |
| D9 | Destruktive Voice-Aktionen (`stop_agents`) verlangen Rückbestätigung ("Wirklich alle Agenten stoppen?") |
| D10 | Assistent→UI-Aktionen (Layout wechseln, Navigation) via neuem Push-Event `ev:uiCommand` + `broadcast()`; Renderer bleibt Owner des UI-States |
| D11 | API-Key: Transkriptions-Key wird per Default für Chat+TTS mitbenutzt; optionale separate Keys in den Settings |
| D12 | Overlay in v1 immer interaktiv (kein Click-through); Linux/Wayland-Fallback: opakes abgerundetes Fenster in `--bg` (Env-Escape `VERTRAGUS_OPAQUE_OVERLAY`), manueller Drag-Fallback falls app-region auf transparenten Wayland-Fenstern zickt |

## Shared Hotspots (genau EIN Integrator-Owner)

`src/shared/ipc.ts`, `src/shared/voiceAssistant.ts` (neu), `src/preload/index.ts`, `src/main/ipc/register.ts`, `src/main/windows.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/store/useAppStore.ts`, `styles.css` (Worker legen NEUE CSS-Dateien an statt hier zu editieren), `locales/de.json`+`en.json` (Integrator merged; Worker liefern Key-Listen).

## Phasierung

```
Phase 0 (seriell, Integrator):   Contracts & Scaffolding
Phase 1 (parallel, 4 Worker):    WS-A Canvas | WS-B Chat | WS-C1 Overlay-Shell | WS-C2 Assistent
Phase 2 (Integration):           Assistent↔Overlay, ev:uiCommand, globalShortcut+Tray, i18n-Merge
Phase 3 (parallel):              WS-D Polish (Command-Palette, A11y, Dark-Theme, Perf)
```

## Phase 0 — Integrator: Contracts & Scaffolding

1. **`src/shared/ipc.ts`**: neue Kanäle `orchestrator:send`, `voiceAssistant:{turn,status,getSettings,setSettings}`, `voiceOverlay:{toggle,hide,moved}`, Push `ev:uiCommand`, `ev:voiceAssistant`. Neues `src/shared/voiceAssistant.ts`: `VoiceAssistantTurnRequest` (`{audio?, mimeType?, text?, history}`), `VoiceAssistantTurnResult` (`{ok, transcript, replyText, replyAudio?, actions, confirmationRequired?}`), Settings-Typen, `UiCommand`, `VoiceAssistantProgressEvent`.
2. **`src/preload/index.ts`**: `orca.orchestrator.send`, `orca.voiceAssistant.*`, `orca.voiceOverlay.*`, `orca.events.onUiCommand` im vorhandenen typisierten Muster.
3. **`src/main/windows.ts`**: `createVoiceOverlayWindow()` (transparent, frameless, alwaysOnTop `'screen-saver'`, skipTaskbar, ~340×140, `secureWindow`, `autoplayPolicy:'no-user-gesture-required'`, Singleton + `toggleVoiceOverlay()`, Bounds via `ui.voiceOverlayBounds` persistiert, Opaque-Fallback `VERTRAGUS_OPAQUE_OVERLAY=1`); `isVoiceWindowSender()` + `isPaneWindowSender()` neben `isMainWindowSender` (:289).
4. **`src/main/ipc/register.ts`**: Handler `orchestrator:send` (Main- ODER Voice-Fenster; resolved Orchestrator-Agent der Session → `seedInteractive`; Rückgabe `{ok, reason?: 'no_orchestrator'|'seed_failed'}`); Stubs für `voiceAssistant:*`; `voiceOverlay:toggle` (main-gated) / `:hide` (voice-gated). **Härtung:** bisher ungegatete `agent:write`/`agent:resize`/`agent:markInteractiveUsed` (:499 ff.) auf Main+Pane-Fenster gaten.
5. **`App.tsx`**: Route `#/voice` → `VoiceOverlay` ohne Shell (wie `#/pane/:id`-Zweig :44-51).
6. **`useAppStore.ts`**: Default `'canvas'` (:368) + einmalige Migration in der Init-Resolution (:503-508); Subscription `ev:uiCommand` → `setWorkspaceLayout`/`location.hash`/`setActiveWorkspaceSession`.
7. i18n-Namespaces anlegen (`canvas.composer.*`, `canvas.thread.*`, `canvas.empty.*`, `voiceOverlay.*`, `voiceAssistant.*`, `palette.*`; DE+EN Key-Parität — `i18n.test.ts`); neue leere `assets/voice-overlay.css`.

**Exit:** typecheck grün, App bootet, `#/voice` zeigt Platzhalter, `orchestrator:send` aus DevTools aufrufbar.

## Phase 1 — WS-A: Canvas-First (Owner: CanvasBoard.tsx, Workspace.tsx, canvasGraph.ts, canvas.css, canvasStore.ts, layoutStore.ts)

- **A1** Layout-Switcher canvas-first umsortieren, Icon+Label-Pills statt `▦ ▭ ✦` (DE: "Zentrale" / "Terminals" / "Fokus").
- **A2** Full-bleed: OrchestratorPanel im Canvas-Layout als absolut positionierter Overlay-Drawer (Toggle-Chip oben rechts, `orchDrawerOpen` in `layoutStore.ts`); Sidebar-Rail (`sidebarCollapsed`-Flag, Auto-Collapse beim Canvas-Einstieg, Re-Expand persistiert); `ws-header` (Workspace.tsx:57-129) zur schlanken Floating-Toolbar über der Canvas.
- **A3** Orchestrator-Node als Interaktions-Hub: vergrößert (~380px), Goal, Activity-Ticker aus dem Snapshot, Status, kompakter `TerminalPeek`. Empty-State als Hero-Card (Profilname, Start-Button → `startAll()`, Playground-Button `window.orca.demo.play()`, 3 Onboarding-Hinweise: Drag / Doppelklick / Chat).
- **A4** Session-Chips oben links (aus `workspaceSessions` im Store): aktive Session hervorgehoben, Klick → `workspaceSessionSetActive`, "+"-Chip startet weitere Session (Multi-Session backend-seitig vorhanden).
- **A5** `CanvasTerminalDrawer`: Bottom-Slide-up (~45%, resizable via vorhandenem `ResizeHandle`), hostet `<AgentPane/>`; Doppelklick öffnet (ersetzt heutiges setSelectedAgent+Layout-Wechsel), Esc schließt; Kontextmenü-Eintrag "Fokus" bleibt.
- Mount-Zone `.canvas-composer-slot` unten mittig für WS-B freihalten.
- Tests: `canvasGraph.test.ts` erweitern (Hub-Node), Store-Test für Default-Migration.

## Phase 1 — WS-B: Orchestrator-Chat in der Canvas (Owner: neu `CanvasComposer.tsx`, `OrchestratorThread.tsx`, `orchestratorActivityRow.tsx`, `canvas-chat.css`, opt. `canvasChatStore.ts`)

- **B1 Composer**: schwebende Pill unten mittig: Auto-Grow-Textarea (Enter=senden, Shift+Enter=Zeile), Mic-Button (→ `voiceOverlay:toggle`), Send. Sendepfad `orca.orchestrator.send(profileId, sessionId, text)`; optimistisches Anhängen an lokalen Thread. **Kein Orchestrator läuft:** "Start-Modus" — Placeholder "Beschreibe dein Ziel …", Send → `startAll()` + `orchestrator.send(text)` (seedInteractive wartet auf CLI-Boot → "Profil mit Ziel starten" ohne Engine-Änderung).
- **B2 Thread**: aufklappbares Panel überm Composer; zeitgeordneter Feed aus Snapshot-Daten: eigene Nachrichten (lokal), Activity-Einträge, Goal-Änderungen, `pendingPlan` mit Inline-Approve/Reject (Handler aus `OrchestratorPanel.tsx` wiederverwenden — Activity-Row als Shared-Subkomponente extrahieren), neue Findings, Task-Phasenwechsel. Orchestrator-Node zeigt letzte Activity-Zeile + Unread-Dot bei zugeklapptem Thread.

## Phase 1 — WS-C1: Voice-Overlay-Fenster (Owner: neu `VoiceOverlay.tsx`, `useVoiceAssistant.ts`, `voice-overlay.css`)

- 72px-Orb (Bronze/Verdigris-Gradient, Cozy-Tokens) + expandierbare Karte (Transkript, Antwort, Status, optionales Text-Eingabefeld). States: idle / listening (`.vwave`-Muster) / thinking / speaking / error, gespeist aus `ev:voiceAssistant`-Progress-Events.
- Drag via `-webkit-app-region: drag` (Controls `no-drag`); manueller Drag-Fallback für Wayland hinter demselben Komponenten-API.
- Klick auf Orb = Push-to-talk-Toggle (Audio-Capture aus `useInboxSpeech` adaptieren); Stop → Bytes an `voiceAssistant.turn` mit History (letzte ~10 Turns lokal). `replyAudio` (TTS) als Blob abspielen; `confirmationRequired` als Ja/Nein-Rückfrage-Karte. "×" → `voiceOverlay.hide()`.
- Transparenter Body route-scoped. Bestehende `VoiceBar` bleibt für Tiles/Focus, wird im Canvas-Layout ausgeblendet; Inbox-Mic unverändert.

## Phase 1 — WS-C2: Assistenten-Gehirn (Owner: neu `src/main/voice/VoiceAssistantService.ts`, `assistantTools.ts`, `OpenAIChatProvider.ts`, `OpenAITtsProvider.ts`; erweitert `types.ts`, `secrets.ts`)

Turn-Pipeline (`voiceAssistant:turn`):
1. **STT**: `transcribeInboxAudio` wiederverwenden (`InboxSpeechService.ts:98`); Text-Input überspringt STT.
2. **Kontext** (`buildContext()`, kompaktes JSON, Cap ~6-8k Zeichen): Profile (`listProfiles()`), Sessions (`workspaceSessions.list()`), Agents (`agentManager.list()`), pro aktiver Session gekürzter `OrchestratorSnapshot` (Goal, Activity-Tail ~5, Tasks mit Phase/lastAction, Findings-Titel, pendingPlan-Summary, Budget), aktueller UI-State.
3. **LLM mit Tools**: OpenAI-kompatibles `/chat/completions` (`OpenAIChatProvider` im Stil von `OpenAITranscriptionProvider`), deutscher Systemprompt, Tool-Loop max. 4 Iterationen.
4. **Tools** (rufen NUR existierende Main-Funktionen):
   - `start_profile_workspace({profileName, goal?})` → Fuzzy-Resolve (normalize/deburr, exact→prefix→includes→Levenshtein≤2; mehrdeutig ⇒ Rückfrage) → `spawnProfileTeam(profile, false, {workingDirOverride: getActiveRepoOverridePath()})`; mit `goal`: `engine.setGoal(goal)` + `seedInteractive(orchestratorId, goal)` (Muster `transferService.ts`)
   - `send_to_orchestrator({text, profileName?})`, `get_status({profileName?})` (Modell verbalisiert Snapshot)
   - `switch_layout({layout})` / `open_view({view})` → `broadcast(ev:uiCommand)`
   - `stop_agents({profileName?, confirmed})` → ohne `confirmed` ⇒ `{needsConfirmation, prompt}` (D9)
5. **TTS**: `/audio/speech`, Bytes im Turn-Result; abschaltbar, Antworttext immer sichtbar.
6. Progress-Events `ev:voiceAssistant` (transcribing→thinking→acting:<tool>→speaking); ausgeführte Aktionen als `ExecutedAction[]` auditierbar.
- Historie kommt pro Request vom Overlay (Service stateless, restart-safe). Settings `voiceAssistant.*` via `getSetting/setSetting`; `SpeechSettingsModal.tsx` um Assistenten-Sektion erweitern. Keys verlassen nie den Main-Prozess.

## Phase 2 — Integration

- Assistent↔Overlay end-to-end (echte `voiceAssistant:*`-Handler statt Stubs).
- `globalShortcut.register('CommandOrControl+Shift+Space', toggleVoiceOverlay)` in `src/main/index.ts` (unregister on will-quit); Mic-Button in `TitleBar.tsx`; `Tray` mit Toggle+Quit.
- i18n-Merge (de zuerst, en nachziehen; `i18n.test.ts`-Key-Parität), CSS-Konsolidierung, `ev:uiCommand`-Flows testen.
- WS-B-Komponenten in `.canvas-composer-slot` mounten; Unread-Dot an Hub-Node; VoiceBar im Canvas-Layout ausblenden.

## Phase 3 — WS-D: Polish (aus der UI-Review, parallelisierbar)

1. **Ctrl+K Command-Palette**: Aktions-Registry `src/renderer/src/commands/registry.ts` (Profil starten, Session/Layout wechseln, View öffnen, Agent fokussieren) + `CommandPalette.tsx` — eine Registry, zwei Frontends (Palette + Voice-Assistent).
2. **Canvas-Keyboard-A11y**: Node-tabIndex, Enter=Drawer, Kontextmenü-Taste, aria-live für Activity-Ticker.
3. **Dark-Theme-Tokenisierung**: hartkodierte Canvas-/Edge-/Minimap-Farben in `canvas.css` gegen Cozy-Organic-Vars; Kontrast-Pass unter `[data-theme='dark']` und `data-density='compact'`.
4. **Findings-Overflow**: "+N weitere"-Notiz (heute hart bei `MAX_CANVAS_NOTES=8` gekappt) verlinkt aufs Findings-Board im Orch-Drawer.
5. **TerminalPeek-Perf**: gebatchter Buffer-Fetch pro Tick statt 1,2s-Poll pro Node (relevant ab ~10 Nodes).

## UI-Review: priorisierte Findings

| Prio | Finding | Abdeckung |
|---|---|---|
| P0 | Canvas ist tertiäres Sub-Layout hinter kryptischen Icons; Default Tiles | WS-A |
| P0 | Kein Weg, MIT dem Orchestrator zu sprechen — Panel read-only, einzige Eingabe rohes xterm | WS-B |
| P0 | Voice = starre Header-Leiste, nur STT-Diktat, kein Kontext/Aktionen/TTS | WS-C |
| P1 | Canvas nie full-bleed; Sidebar nicht kollabierbar | WS-A2 |
| P1 | Layout-Wechsel für Terminal-Zugriff zerstört räumlichen Kontext | WS-A5 |
| P1 | Multi-Session existiert backend-seitig, Umschalten aber vergraben | WS-A4 |
| P2 | Keine Command-Palette, kaum Shortcuts (kein globalShortcut im Code) | WS-D1 |
| P2 | Empty-States inkonsistent (Tiles reich, Canvas leer) | WS-A3 |
| P2 | Orchestrator-Node visuell gleichrangig mit Task-Nodes | WS-A3 |
| P3 | Findings-Notizen hart auf 8 gekappt ohne Overflow-Affordance | WS-D4 |
| P3 | Canvas-Farben teils hartkodiert (Dark-Theme-Kontrast) | WS-D3 |
| P3 | Canvas nicht tastaturbedienbar | WS-D2 |
| P3 | TerminalPeek pollt 1,2s pro Node | WS-D5 |

## Verifikation

**Automatisiert:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (vitest; bestehende Suites grün halten: `canvasGraph.test.ts`, `i18n.test.ts`, `InboxSpeechService.test.ts`, `Sidebar.test.ts`, `OrchestratorPanel.test.ts`, `ResizeHandle.test.ts`). Neue Tests: VoiceAssistantService-Tool-Loop mit gemocktem Chat-Provider (Muster `__setTranscriptionProviderForTest`), Fuzzy-Resolve (exakt/Umlaute/mehrdeutig), Confirmation-Gating, Kontext-Truncation, `orchestrator:send`-Resolution, Store-Migrationstest. `pnpm test:ui-smoke` muss mit Canvas-Default bestehen.

**Manuell (`pnpm dev`):**
1. Frische Config → App öffnet auf Canvas mit Hero-Empty-State; Tiles wählen, Neustart → Tiles bleibt.
2. Ziel in Composer auf leerer Canvas tippen → Team spawnt, Goal wird nach CLI-Boot geseedet, Activity im Thread; Plan aus dem Thread approven.
3. Doppelklick auf Task-Node → Terminal-Drawer mit lebendem xterm, Esc schließt.
4. Ctrl+Shift+Space → Orb; über den Fensterrand hinaus auf den Desktop/zweiten Monitor ziehen; Neustart → Position wiederhergestellt; always-on-top. (Wayland-Transparenz früh testen → ggf. Opaque-Fallback.)
5. "Starte Profil Vertragus" sprechen → Bestätigung (Text+TTS), neue Session + Agents auf der Canvas. "Was machen die Agenten gerade?" → gesprochene Zusammenfassung passt zum Snapshot. "Stoppe alle Agenten" → Rückfrage, erst nach Bestätigung Stopp.
6. Security: aus Overlay-DevTools muss `window.orca.agents.spawnProfile` abgelehnt werden; `voiceAssistant.turn` funktioniert; kein API-Key im Renderer.
7. Ctrl+K-Palette per Tastatur. 8. Dark-Theme + Compact-Density-Pass.

---

## Ausführungs-Blocker (Stand 2026-07-18)

Drei Orchestrierungs-Läufe wurden abgebrochen. Ursachen (verifiziert im Code dieses Stands):

1. **Lauf 1 — Infrastruktur, behoben:** Pane-Preflight scheiterte mit `spawn corepack ENOENT`. Ursache: fnm verlinkt nur `node` nach `~/.local/bin`; `corepack`/`pnpm`/`npm` fehlten im PATH des App-Prozesses. Fix (dauerhaft): Symlinks `corepack`, `npm`, `npx`, `pnpm`, `pnpx` aus `~/.local/share/fnm/node-versions/v24.18.0/installation/bin/` nach `~/.local/bin/`.
2. **Lauf 2 — Permission-Gate + Fehlbewertung:** Alle Worker-Schreiboperationen wurden vom Orca-Permission-Broker abgelehnt (`Orca permission denied or timed out`). Zusätzlich wurde der wartende Phase-0-Worker („Timer läuft…") vom Judge fälschlich als success/no-changes gewertet, wodurch Phase-1-Worker ohne Contracts starteten → Abbruch.
3. **Lauf 3 — Permission-Gate strukturell:** Auch mit aktiviertem YOLO-Master in der UI blieben Writes blockiert. Ursache im Code:
   - Worker-YOLO wird beim Dispatch aus `slot.yolo || boundProfile.yoloDefault` bestimmt (`Engine.ts:1444`); `boundProfile` ist der **beim Session-Start geklonte** Profil-Snapshot (`WorkspaceSessionRegistry.create` → `cloneProfile`). Nachträgliche Änderungen (UI-Toggle, Store-Update) erreichen eine laufende Session nicht.
   - Der UI-YOLO-Master wirkt nur über `spawnProfileTeam(profile, yoloMaster)` (`spawnProfile.ts:21`: erzwingt `yoloDefault:true` im Session-Profil) — d.h. nur für **neu gestartete** Workspace-Sessions.
   - Nicht-YOLO-Worker fragen jede Tool-Nutzung über `Engine.requestToolPermission` → `PermissionBroker.requestDecision` an; unbeantwortete Prompts laufen nach **60 s in deny** (`PermissionBroker.ts:105,181`). Bei hunderten Writes pro Task ist manuelles Approven nicht praktikabel.

**Vorbedingungen für den nächsten Anlauf (eine davon):**
- **Empfohlen:** Im Profil (ProfileEditor) `yoloDefault` bzw. per-Slot `yolo` aktivieren, dann den Workspace **neu starten** (neue Session bindet das aktualisierte Profil) und den Plan erneut dispatchen. Alternativ mit aktivem YOLO-Master „Start" drücken (erzwingt YOLO im Session-Profil).
- Oder (Produktfix, empfehlenswert unabhängig davon): YOLO-Master-Änderungen zur Laufzeit an laufende Engines propagieren (z.B. `Engine.setYolo(master)` analog `setPlannerMode`, das `boundProfile.yoloDefault` rebindet), und/oder Judge-Härtung: ein Worker-Abschluss mit `no-changes` und ausstehenden Permission-Denials darf nicht als success gewertet werden.

Der genehmigte Plan oben ist davon unberührt und direkt wiederverwendbar (identischer 9-Task-DAG: t0-contracts → WS-A/B/C1/C2 parallel → Tests/Audit → Integrator).
