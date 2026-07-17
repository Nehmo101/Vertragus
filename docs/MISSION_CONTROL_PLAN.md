# Mission Control — die sichere Remote-Kommandozentrale für Vertragus

> Gesamt-Plan / Architektur-Blueprint über alle Phasen (A–C + Ausblick).
> Status: Phase A freigegeben und umsetzbereit; Phase B/C detailliert vorgeplant.

## Context

Vertragus ist heute eine reine Desktop-App (Electron), die mehrere KI-Coding-CLIs
vendor-neutral orchestriert, Arbeit in Git-Worktrees isoliert und Auto-PRs öffnet. Sobald
ein Lauf minuten- bis stundenlang autonom arbeitet, ist der Nutzer an den Rechner
gefesselt, an dem Vertragus läuft. **Mission Control** hebt das Tool in eine neue Dimension: den
Agenten-Schwarm **von überall vom Handy aus** live beobachten, an genau den Stellen
eingreifen, an denen Vertragus ohnehin auf eine Entscheidung wartet (Plan-Review, blockierte
Tasks, PR-Freigabe), und neue Ziele unterwegs diktieren — abgesichert durch Geräte-Pairing,
widerrufbare Tokens, Audit-Log und Not-Aus.

Das Fundament liegt bereits im Code, ist aber bewusst zurückgestellt:
- **Cloudflare Tunnel** ist als Provider registriert (`src/shared/providers.ts:145`,
  `cloudflared`, `tunnel login`), markiert „remote access (later)".
- Der Agent-Status **`waiting`** ist „reserved for approval detection (later)"
  (`src/shared/agents.ts:17`).
- Ein token-authentifizierter `node:http`-Server existiert schon
  (`src/main/orchestrator/OrcaMcpServer.ts`; `Orca*`-Klassennamen bleiben
  interne Bezeichner, Migration geplant) — das exakte Vorbild fürs Gateway.
- `OrchestratorSnapshot` (`src/shared/orchestrator.ts:242`) ist der fertige, Node-freie
  Read-Model-Typ, den der Browser-Client direkt importiert.

**Getroffene Entscheidungen:**
1. **Umfang Phase A:** Beobachten + Freigeben **und** neue Ziele aus der Ferne senden
   (über den Idea-Transfer-Pfad, erzwungen non-yolo, hart rate-limitiert, eigene
   `steer`-Berechtigung).
2. **Erreichbarkeit:** **Named Cloudflare Tunnel** mit stabiler URL (erfordert
   Cloudflare-Konto + `cloudflared tunnel login`); Cloudflare-Credential via `safeStorage`
   verschlüsselt. Quick-Tunnel nur als Dev-/Fallback-Komfort.

## Kernprinzipien (gegen den Code verifiziert, gelten in ALLEN Phasen)

- **Kein offener Port.** Das Gateway bindet nur `127.0.0.1` (wie `OrcaMcpServer`
  `httpServer.listen(0, '127.0.0.1', …)`). Erreichbarkeit entsteht ausschließlich durch die
  **ausgehende** `cloudflared`-Verbindung zur Cloudflare-Edge.
- **Der Tunnel ist nur ein Rohr, kein Schutz.** Die Tunnel-URL gilt als öffentlich →
  **Token-Auth ist bei jedem Daten-/Command-Request Pflicht.**
- **Eine Wahrheit.** Der Read-Model-Stream hängt am selben `workspaceSessions.on('snapshot')`-
  Bus, den heute schon der Desktop-Renderer nutzt — kein zweiter Zustand, keine Divergenz.
- **Nur bestehende Operationen.** Jeder Remote-Command mappt 1:1 auf eine Methode, die die
  Desktop-UI heute schon aufruft — es wird der Engine keine neue Macht gegeben, nur ein
  neuer, streng gefilterter Aufrufer.
- **Standardmäßig aus.** Frische Installationen starten Gateway und Tunnel nicht; explizites
  Opt-in pro Nutzer.
- **Additiv & rückbaubar.** Jede Phase ist ein Feature-Flag; Remote lässt sich jederzeit
  vollständig deaktivieren, ohne den Desktop-Betrieb zu berühren.

## Architektur

```
 Handy/Browser (PWA)             Named Cloudflare Tunnel        Electron Main-Prozess
 ┌──────────────────┐  HTTPS/SSE  ┌──────────────┐  :127.0.0.1  ┌───────────────────────────┐
 │ Live-DAG         │◄───────────►│  cloudflared │◄────────────►│ RemoteGateway (node:http) │
 │ Approval-Inbox   │  POST /cmd  │  (outbound)  │              │  Auth · Whitelist · SSE   │
 │ Ziel senden      │  (Phase C:  │              │              │  Audit · RateLimit        │
 │ Push (Phase B)   │   ws)       │              │              │  Push (B) · Broker (C)    │
 └──────────────────┘             └──────────────┘              └────────────┬──────────────┘
                                              subscribe (readModel)           │ whitelisted
                                              workspaceSessions.on('snapshot')│ calls
                                                                ┌─────────────▼──────────────┐
                                                                │ OrchestratorEngine (DAG)    │
                                                                │ reviewPlan · transferIdea · │
                                                                │ approvePublication (B) ·    │
                                                                │ PermissionBroker (C)        │
                                                                └─────────────────────────────┘
```

## Phasen-Überblick

| Phase | Kernnutzen | Wesentliche Bausteine | Neue Deps | Aufwand | Risiko |
|---|---|---|---|---|---|
| **A — MVP** | Von überall beobachten, freigeben, Ziele senden | Gateway, Auth/Pairing, SSE-Read-Model, Command-Whitelist, Approval-Inbox, Named Tunnel, PWA, Audit | QR-Lib | Hoch | Mittel |
| **B — Weg-vom-Rechner** | Push aufs Handy, PR-Freigabe aus der Ferne, Diff-Ansicht, robuster Tunnel | Web-Push/VAPID, `hold-for-approval`, `task.diff`, Tunnel-Härtung, Sprach-Ziel | `web-push` | Mittel | Niedrig–Mittel |
| **C — Echtzeit & Team** | Jeden Tool-Prompt aus der Ferne freigeben; Mehrbenutzer | Per-Tool-Berechtigungs-Broker (per Provider), `ws`-Kanal, Identität/Access, Budgets | `ws` (+ CF Access) | Hoch | Hoch (provider-abhängig) |
| **D — Ausblick** | Fern-Budgetierung, Pause/Resume, Live-Replan | Kosten-/Token-Budgets, Task-Pause-Primitive, Replan-Historie | — | Offen | Offen |

---

## Phase A — MVP (freigegeben)

### Neue Module (Main-Prozess, `src/main/remote/`)

| Datei | Aufgabe | Vorbild/Reuse |
|---|---|---|
| `RemoteGateway.ts` | `node:http`-Server: Router, Auth-Middleware, Body-Cap, RateLimit, SSE-Hub, PWA-Shell ausliefern. `start/stopRemoteGateway()`. | `OrcaMcpServer.startMcpServer()`, `MAX_REQUEST_BODY_BYTES`, `readBody` |
| `gatewayHandle.ts` | Import-zyklusfreier Handle-/Port-Halter. | `orchestrator/mcpHandle.ts` |
| `deviceAuth.ts` | Pairing-Codes, Token-Mint (256-bit `randomBytes`), **nur Hash speichern**, `timingSafeEqual`-Prüfung, Widerruf, Geräte-Liste, Capabilities (`read`/`steer`/`admin`). | `node:crypto` |
| `deviceStore.ts` | `safeStorage`-verschlüsselte Geräte-Records unter `secrets.remote.*`. | `config/secrets.ts` |
| `readModel.ts` | Abo auf `workspaceSessions.on('snapshot')`, letzter Snapshot je Session, SSE-Fan-out, `deriveApprovals()`. | `register.ts`-Snapshot-Wiring |
| `commands.ts` | Whitelist-Tabelle `{ id, zodSchema, handler }`; unbekannt → 404. | — |
| `auditLog.ts` | Append-only JSONL jeder Auth/Command; über `redactDiagnosticValue`. | `diagnostics/runJournal.ts` |
| `rateLimit.ts` | Token-Buckets: strenger Pre-Auth-Bucket auf `/pair`, per-Gerät-Bucket auf Commands. | — |
| `tunnelManager.ts` | Named-Tunnel-Lebenszyklus über `cloudflared` (login/create/run), URL-Parse, Restart-Backoff, Stop am Toggle. | `agents/resolveCommand.ts`, `providers.ts` |
| `selftestRemote.ts` | `ORCA_REMOTE_SELFTEST=1`-Integrationstest. | `orchestrator/selftest.ts` |
| `qrcode.ts` | QR-Matrix (Pairing) als SVG/Data-URL. | — |

**Neu (Shared):** `src/shared/remote.ts` — pure Typen (kein Node-Import), vom PWA direkt
importiert: `RemoteCommandId`-Union, `RemoteCommandEnvelope`, `ApprovalItem`/`ApprovalKind`,
`DeviceInfo` (nie mit Token), `RemoteEventFrame` (`snapshot`/`approvals`/`event`/`ping`),
`PairingChallenge`. Nutzt `OrchestratorSnapshot`/`OrcaTask`/`PendingPlanReview` unverändert.

**Neu (Client):** `apps/mobile/` — eigenständige Vite-+-React-PWA (eigenes `package.json`,
`manifest.webmanifest`, `service-worker.ts`), baut nach `apps/mobile/dist`; das Gateway
liefert diese statischen Dateien als öffentliche Shell aus. Importiert `src/shared/` per
Alias. Screens: Pair, Live-DAG, Approval-Inbox, Neues Ziel, Geräte/Einstellungen. DAG-Logik
kann `src/renderer/src/orchestratorActivity.ts` wiederverwenden (mobile-first gerendert).

### Geänderte Dateien (klein, additiv)

- `src/main/index.ts` — nach `startMcpServer()` ein guarded `startRemoteGatewayIfEnabled()`
  (nur wenn `remote.enabled === true`); `ORCA_REMOTE_SELFTEST`-Zweig neben `ORCA_MCP_SELFTEST`;
  Gateway-/Tunnel-Teardown im `before-quit`.
- `src/shared/ipc.ts` + `src/main/ipc/register.ts` + Preload — **desktop-only** `remote`-API:
  `remoteStatus`, `remoteEnable`, `remoteDisable` (Not-Aus), `remoteListDevices`,
  `remoteRevokeDevice`, `remotePairStart` (QR-Payload+Code) + Push-Kanal `evRemote`.
  Das Handy nutzt **nie** IPC, nur das Gateway.
- `src/main/config/configAccess.ts` — `remote.enabled` in die Public-Get/Set-Keys; `secrets.remote.*`
  bleibt durch `rejectSecretsKey` blockiert.
- `src/shared/orchestrator.ts` — `OrchestratorSnapshot` optional um `pendingApprovals` erweitern
  (oder rein im `readModel` ableiten, um Engine-Änderungen zu vermeiden).
- `electron.vite.config.ts` / Build + `package.json` — PWA-Build einhängen & mitliefern.

### Befehls-Whitelist (streng, alles auf Bestehendes gemappt)

| Command | Args (zod) | Mapping | Berechtigung |
|---|---|---|---|
| `plan.approve` / `plan.reject` | `{profileId, sessionId, approved}` | `workspaceSessions.reviewPlan` | `steer` |
| `mode.enableAuto` | `{profileId, sessionId}` | `enableAutoMode` | `steer` |
| `run.reset` | `{profileId, sessionId}` | `reset` | `admin` |
| `goal.submit` | `{profileId, text}` | `createIdea` + `transferIdeaToProfile({…, yoloMaster:false})` | `steer`, rate-limitiert, **nie yolo** |
| `killSwitch.activate` | `{}` | Gateway-Stop + Tunnel-Stop + `revokeAll()` | `read` (jedes Gerät darf stoppen) |

**Niemals exponiert (mit Grund):** `agent.write` (Roh-PTY-stdin = RCE als Nutzer),
freies `spawn`/`spawnProfile` (frei wählbarer Provider/Dir/yolo = RCE), `agent.buffer`
(Scrollback enthält Quellcode/Tokens), jedes `config:set` und alle `secrets.*`,
Quality-Gate-Command-Strings (`autoPr.ts` nutzt `shell`), Provider-Login/OAuth, Datei-/
Ordner-Picker. **Regel:** ein Remote-Command darf nur strukturierte, zod-validierte,
größenbegrenzte Daten übergeben — nie einen Command-String, Pfad oder freien Provider-Selektor.

### Sicherheit (Kern)

- **Pairing:** Desktop mintet Einmal-Code (128-bit, TTL ≈ 5 min, single-use), zeigt QR mit
  Tunnel-URL. Handy postet `/pair {code, deviceName}`; Gateway prüft (constant-time,
  Pre-Auth-RateLimit) und gibt **einmalig** einen 256-bit-Token zurück. Gespeichert wird nur
  `sha256(token)` (via `safeStorage`) → eine gestohlene Config-Datei ergibt keine nutzbaren Tokens.
- **Pro Request:** `Authorization: Bearer <token>` im **Header** (nicht Query); Hash +
  `timingSafeEqual` gegen nicht-widerrufene Geräte; sonst 401.
- **Widerruf & Not-Aus:** Einzelgerät widerrufen; „Alle widerrufen"; Master-Not-Aus stoppt
  Tunnel + Gateway und setzt persistent `remote.enabled=false`. Weil der Tunnel stirbt, ist der
  Origin binnen Sekunden unerreichbar. Dauerhaftes „Remote aktiv"-Warnsignal im Desktop.
- **Audit-Log:** jede Auth/Command redigiert als JSONL (`0o600`, size-capped, `redactDiagnosticValue`);
  nie Token/Hash loggen, nur Geräte-ID.
- **Härtung:** Body-Cap (Commands enger, z.B. 64 KB), RateLimit, strenge CSP/`nosniff`/`no-referrer`,
  **Host-Header-Allowlist** gegen DNS-Rebinding, `127.0.0.1`-Bind.
- **safeStorage nicht verfügbar** (Linux ohne Keyring): Remote-Aktivierung wird **verweigert**
  (sicherer Default), mit klarer Meldung — kein Klartext-Fallback.

### Approval-Inbox (aus vorhandenen Gates)

`deriveApprovals(snapshots)` projiziert eine einheitliche Queue aus vorhandenen Snapshot-Feldern
— ohne CLI-Prompts abzufangen:
1. **Plan-Review** — `snapshot.pendingPlan`; approve/reject → `reviewPlan`.
2. **Blockierter/needs-work-Task** — `status:'needs-work'|'error'` mit `recoveryArtifact`/`blocker`;
   Aktion v1: `run.reset`/`mode.enableAuto`.
Beim Parken erhält der Task/Agent den `waiting`-Status → im DAG (Desktop **und** Handy) sichtbar.

### Verifikation Phase A
- **Unit (Vitest):** `deviceAuth` (Token-Entropie/Uniqueness, `timingSafeEqual`, widerrufen,
  abgelaufener/replayter Code, **Roh-Token nie im Store**); `commands` (Deny-List-Regression:
  `agent.write`/`spawn`/`config.set` haben KEINE Route; zod lehnt Malformed ab); `auditLog`
  (Redaktion); `readModel` (Approval-Projektion, SSE-Frame == Input-Snapshot); `rateLimit`;
  `tunnelManager` (URL-Parse, Backoff); `configAccess` (`secrets.remote.*` bleibt blockiert).
- **Integration:** `ORCA_REMOTE_SELFTEST=1` — unauth → 401, pairen → 200, `pendingPlan` über SSE
  → `plan.approve` löst auf, widerrufenes Gerät gedroppt, Audit redigiert.
- **E2E:** `pnpm dev` → Remote an → QR am Handy → Live-DAG spiegelt Desktop → Plan freigeben →
  Ziel senden → Not-Aus → Stream weg binnen Sekunden.

---

## Phase B — „Weg vom Rechner"

Ziel: Mission Control auch dann nützlich machen, wenn das Handy in der Tasche steckt —
Benachrichtigungen holen den Nutzer, die PR-Freigabe wird ein echtes Fern-Gate, Diffs sind
sicher einsehbar, und der Tunnel überlebt Netzwechsel.

### B1 · Push-Benachrichtigungen (Web-Push / VAPID)
- **Neues Modul** `src/main/remote/pushService.ts`; **neue Dep** `web-push`.
- VAPID-Keypair einmalig erzeugen; **Private-Key** via `safeStorage` unter `secrets.remote.vapid`;
  Public-Key an die PWA ausliefern. Push-Subscriptions liegen im verschlüsselten Geräte-Record
  und werden bei Widerruf entfernt.
- `pushService` abonniert `workspaceSessions.on('snapshot')` und **diffed gegen den letzten
  Stand je Session** — Auslöser nur bei Transitions (kein Spam auf dem 1-Hz-Heartbeat):
  Plan wartet auf Review · Task blockiert/needs-work · PR geöffnet (`prUrl`/`autoPrStatus`) ·
  Lauf fertig · Nutzungslimit (`LimitWarning`, `LIMIT_KIND_LABELS` liefert fertige Labels).
- **PWA:** Service-Worker `push` + `notificationclick` (Deep-Link zum betroffenen Approval).
- **iOS/Android-Realität:** iOS nur als **installierte** PWA (Add-to-Home-Screen, Safari 16.4+);
  Pair-Screen weist darauf hin; bei verweigerter Notification-Permission Fallback auf In-App-
  SSE-Badges. `410 Gone` vom Push-Endpoint → Subscription verwerfen und neu anfragen.
- **Tests:** Transition-Diff-Logik (Snapshot-Folge → korrekte, deduplizierte Notification-Menge);
  Subscription-Expiry; jeder Versand auditiert.

### B2 · PR-Freigabe als echtes Remote-Gate
- **Shared:** neuer Enum-Wert `autoPr.mode: 'hold-for-approval'` (`src/shared/profile.ts`),
  zod-Default rückwärtskompatibel.
- **Engine:** in `publishPendingChanges` bei `hold-for-approval` die vorbereiteten Änderungen
  sammeln (`autoPrStatus:'prepared'`), `ApprovalItem{kind:'pr-publication'}` emittieren und am
  Promise parken (gleiches Muster wie `requestPlanReview`). Neue Methode
  `engine.approvePublication(planId?)` löst auf → ruft unverändert `publishPreparedChanges(...)`.
  Reject → Änderungen bleiben `prepared`, Tasks `waiting`.
- **Whitelist:** `publication.approve`/`publication.reject` (`steer`). `deriveApprovals` ergänzt
  den `pr-publication`-Eintrag.
- **Tests:** Engine parkt im Hold-Modus; `approvePublication` veröffentlicht; Reject hält;
  Command-Mapping.

### B3 · `task.diff` über die Leitung (sichere Diff-Ansicht)
- **Neuer Command** `task.diff` mit **eigener Capability `diff`** (pro Gerät, default aus).
  Mapping auf `loadTaskReviewDiff` (bereits größenbegrenzt), zusätzlich durch
  `redactDiagnosticValue` und ein hartes Mobile-Byte-Limit; jeder Zugriff auditiert.
- **PWA:** read-only Diff-Viewer, lazy pro Task geladen.
- **Tests:** Redaktion des Diff-Payloads; Capability-Gate (`diff` fehlt → 403); Size-Cap.
- **Begründung der Sonderbehandlung:** Quelldiffs sind die größte Datenleck-Fläche → deshalb
  eigene, standardmäßig deaktivierte Berechtigung, nicht Teil von `read`.

### B4 · Tunnel-Robustheit + Quick-Tunnel-Komfort
- **Quick-Tunnel** (Dev/Fallback): `cloudflared tunnel --url http://127.0.0.1:<port>`,
  `*.trycloudflare.com` aus stderr parsen.
- **Named-Tunnel** (Default): Config-Datei verwalten, CF-Credential via `safeStorage`
  (`secrets.remote.cloudflare`), Health-Monitoring, `degraded`-Status via `evRemote`,
  Reconnect mit gedeckeltem Backoff, Startup-Timeout (~20 s).
- **Desktop-UI:** Tunnel-Status, „URL kopieren", „Neu pairen".
- **Tests:** URL-Parse (quick & named), Backoff, `degraded`-Transitions.

### B5 · Sprach-Ziel (optional, reine Wiederverwendung)
- Gateway-Endpoint nimmt Audio vom Handy → `InboxSpeechService` (existiert) → Transkript
  zurück → Nutzer bestätigt → `goal.submit`. Rate-limitiert, Capability `steer`.

---

## Phase C — Echtzeit & Team (schwer, provider-abhängig)

### C1 · Echtzeit-Per-Tool-Berechtigungs-Broker
Die Tiefen-Variante der Approval-Inbox: den **eigenen** Tool-Prompt jedes Agenten
(„Darf ich `rm -rf` ausführen?") abfangen und aufs Handy routen.

- **Kern-Problem (ehrlich):** Jede CLI hat eine eigene Permission-UX. Deshalb eine
  `PermissionBroker`-Abstraktion mit **Provider-Adaptern**, inkrementell ausgerollt:

  | Provider | Ansatz | Traktabilität |
  |---|---|---|
  | **Claude** | Non-yolo + MCP-Permission-Prompt-Tool / PreToolUse-Hook → Callback ans Gateway | Am besten (zuerst) |
  | **Codex** | Sandbox-Policy (`workspace-write`) + Prompt-Callback bzw. PTY-Prompt-Parsing | Mittel |
  | **Copilot** | Nur grobes `--allow-all-tools`; feingranular begrenzt | Grob |
  | **Cursor** | Worker-only, `--trust`; begrenzt | Begrenzt |
  | **Ollama** | Lokal, kein natives Gating | Nicht anwendbar |

- **Wo kein strukturierter Callback existiert:** entweder (a) non-yolo laufen lassen und den
  PTY-Prompt je Provider parsen und die Antwort **intern** via `agent.write` zurückschreiben
  (die Antwort-Keystroke ist Vertragus-intern, **nie** vom Remote-Client direkt steuerbar), oder
  (b) klar gekennzeichneter Fallback auf blanket-yolo/deny.
- **Transport:** bidirektional & latenzarm → **`ws`** (WebSocket) hinter derselben Auth-Middleware
  (SSE + POST wäre zu träge). Neue Whitelist-Commands `permission.allow`/`permission.deny`
  (neue Capability `approve-tools`).
- **Timeout-Policy:** ohne Antwort binnen N Sekunden → **default-deny** (sicher), Task `waiting`.
- **Engine-Fläche:** `engine.pendingPermission`-Events; Broker-Resolve.
- **Tests:** Adapter-Contract je Provider (Mock-Prompt → pending → allow/deny → Agent
  proceeds/aborts); default-deny bei Timeout; `ws`-Auth.
- **Roadmap-Ehrlichkeit:** Abdeckung uneinheitlich; als Research-Spikes + Provider-für-Provider
  ausliefern (Claude zuerst), nicht als ein Deliverable.

### C2 · Team / Mehrbenutzer
- Mehrere Besitzer/Geräte mit Rollen; Per-User-Capabilities; Per-Session-Scoping (ein Gerät
  sieht nur zugewiesene Sessions).
- Braucht eine Identitätsschicht über die Single-Owner-Token hinaus:
  **Cloudflare Access** (SSO-Identität an der Edge; Gateway vertraut dem validierten
  Identity-Header) ist der Low-Code-Pfad und passt zum Named-Tunnel-CF-Konto; Alternative:
  App-eigene Accounts.
- Audit-Log erhält Actor-Identität; Approvals zeigen, wer gehandelt hat.
- Größerer Scope — vermutlich eigene Initiative.

### C3 · Erweiterte Fernsteuerung
- Live-Token/Kosten-Budget-Ansicht + **Fern-Budget-Caps** (Roadmap: Kosten/Token end-to-end).
- **Pause/Resume** einzelner Tasks (braucht Engine-Pause-Primitive — neu).
- Provider-Fallback bei Rate-Limit aus der Ferne auslösen (Roadmap: Provider-Fallbacks).
- Plan-Vorschau / Live-Replan mit Historie vom Handy.

---

## Phase D — Ausblick (optional, an bestehende Roadmap angedockt)

Aus `docs/ORCA_STRATOR_ROADMAP.md` / `IMPLEMENTATION_STATUS.md` bereits als „weitere sinnvolle
Features" vorgemerkt und über Mission Control fernbedienbar: Kosten-/Token-Budgets end-to-end,
Approval-Inbox als eigenständiges Desktop-Feature, Provider-Fallbacks bei Limit, Diff/Merge-
Center. Diese sind **nicht** Mission-Control-exklusiv, profitieren aber direkt vom Remote-Kanal
und den Approval-Primitiven aus A–C.

---

## Querschnitt: Sicherheit über alle Phasen (Invarianten)

Diese müssen in **jeder** Phase gelten — Review-Checkliste:
1. Standardmäßig aus; expliziter Opt-in; safeStorage-Pflicht (sonst Verweigerung).
2. Token-Auth (Header-Bearer, Hash-only, `timingSafeEqual`) bei **jedem** Daten-/Command-Request.
3. Whitelist-only: keine Roh-Shell, kein direkter Agent-stdin remote steuerbar (auch nicht in C —
   die Broker-Antwort ist Vertragus-intern), kein `config:set`/`secrets.*`, kein Command-String/Pfad.
4. Alles auditiert & redigiert; nie Token/Klartext-Secrets im Log.
5. Widerruf pro Gerät + Master-Not-Aus, der Tunnel & Gateway sofort niederreißt.
6. Body-Caps, Rate-Limits, Host-Header-Allowlist, `127.0.0.1`-Bind.
7. Neue Fern-Fähigkeit = eigene Capability, restriktiver Default (z.B. `diff`, `approve-tools`).

## Abhängigkeiten & neue Pakete

| Paket | Phase | Zweck | Alternative |
|---|---|---|---|
| QR-Lib (klein, pur-JS) | A | Pairing-QR im Desktop | eigener QR-Matrix-Encoder (`qrcode.ts`) |
| `cloudflared` (extern) | A | Named/Quick Tunnel | LAN-only-Modus |
| `web-push` | B | VAPID-JWT + Payload-Encryption | Hand-Roll mit `node:crypto` (nicht empfohlen — ECDH/HKDF) |
| `ws` | C | Bidirektionaler Low-Latency-Kanal | SSE + POST-Roundtrip (träger) |
| CF Access (extern) | C | Team-Identität an der Edge | App-eigene Accounts |

Das Repo ist bewusst dependency-arm — jede Dep bleibt optional/lazy und nur bei aktiviertem
Remote relevant.

## Kritische Dateien (Reuse-Anker)
- `src/main/orchestrator/OrcaMcpServer.ts` — Auth/Body-Cap/`node:http`-Muster fürs Gateway.
- `src/main/ipc/register.ts` — `workspaceSessions.on('snapshot')`-Verdrahtung (Read-Model-Abo + Command-Home).
- `src/main/orchestrator/Engine.ts` — `push()`-Snapshot, `reviewPlan`/`pendingPlan`, `publishPendingChanges` (Gates + `approvePublication` + `waiting` + `pendingPermission`).
- `src/main/config/secrets.ts` — safeStorage-Muster für Token/VAPID/Cloudflare-Cred.
- `src/main/diagnostics/runJournal.ts` — `redactDiagnosticValue` + JSONL-Writer fürs Audit-Log.
- `src/main/agents/resolveCommand.ts` + `src/shared/providers.ts` — `cloudflared`-Auflösung/Provider-Def.
- `src/main/inbox/transferService.ts` — `transferIdeaToProfile` für `goal.submit`.
- `src/shared/orchestrator.ts` — Typen, die die PWA direkt importiert (`OrchestratorSnapshot`/`PendingPlanReview`).
