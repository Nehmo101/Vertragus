# Mission Control — die sichere Remote-Kommandozentrale für Orca-Strator

> Feature-Plan / Architektur-Blueprint. Status: freigegeben, bereit für Phase-A-Umsetzung.

## Context

Orca-Strator ist heute eine reine Desktop-App (Electron), die mehrere KI-Coding-CLIs
vendor-neutral orchestriert, Arbeit in Git-Worktrees isoliert und Auto-PRs öffnet. Sobald
ein Lauf minuten- bis stundenlang autonom arbeitet, ist der Nutzer an den Rechner
gefesselt, an dem Orca läuft. **Mission Control** hebt das Tool in eine neue Dimension: den
Agenten-Schwarm **von überall vom Handy aus** live beobachten, an genau den Stellen
eingreifen, an denen Orca ohnehin auf eine Entscheidung wartet (Plan-Review, blockierte
Tasks), und neue Ziele unterwegs diktieren — abgesichert durch Geräte-Pairing,
widerrufbare Tokens, Audit-Log und Not-Aus.

Das Fundament liegt bereits im Code, ist aber bewusst zurückgestellt:
- **Cloudflare Tunnel** ist als Provider registriert (`src/shared/providers.ts:145`,
  `cloudflared`, `tunnel login`), markiert „remote access (later)".
- Der Agent-Status **`waiting`** ist „reserved for approval detection (later)"
  (`src/shared/agents.ts:17`).
- Ein token-authentifizierter `node:http`-Server existiert schon
  (`src/main/orchestrator/OrcaMcpServer.ts`) — das exakte Vorbild fürs Gateway.
- `OrchestratorSnapshot` (`src/shared/orchestrator.ts:242`) ist der fertige, Node-freie
  Read-Model-Typ, den der Browser-Client direkt importiert.

**Getroffene Entscheidungen:**
1. **Umfang Phase A:** Beobachten + Freigeben **und** neue Ziele aus der Ferne senden
   (über den Idea-Transfer-Pfad, erzwungen non-yolo, hart rate-limitiert, eigene
   `steer`-Berechtigung).
2. **Erreichbarkeit:** **Named Cloudflare Tunnel** mit stabiler URL (erfordert
   Cloudflare-Konto + `cloudflared tunnel login`); Cloudflare-Credential via `safeStorage`
   verschlüsselt. Quick-Tunnel nur als Dev-/Fallback-Komfort.

## Kernprinzipien (gegen den Code verifiziert)

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
- **Transport:** **SSE** für den Server→Client-Stream (nativ, Auto-Reconnect, tunnel-fest);
  Commands als einzelne authentifizierte `POST`s (ein Audit-Eintrag pro Command). WebSocket
  ist eine bewusste Zurückstellung, kein Versäumnis (erst nötig für den Echtzeit-Broker in
  Phase C).

## Architektur

```
 Handy/Browser (PWA)             Named Cloudflare Tunnel        Electron Main-Prozess
 ┌──────────────────┐  HTTPS/SSE  ┌──────────────┐  :127.0.0.1  ┌───────────────────────────┐
 │ Live-DAG         │◄───────────►│  cloudflared │◄────────────►│ RemoteGateway (node:http) │
 │ Approval-Inbox   │  POST /cmd  │  (outbound)  │              │  Auth · Whitelist · SSE   │
 │ Ziel senden      │             └──────────────┘              │  Audit · RateLimit        │
 └──────────────────┘                                           └────────────┬──────────────┘
                                              subscribe (readModel)           │ whitelisted
                                              workspaceSessions.on('snapshot')│ calls
                                                                ┌─────────────▼──────────────┐
                                                                │ OrchestratorEngine (DAG)    │
                                                                │ reviewPlan · transferIdea … │
                                                                └─────────────────────────────┘
```

## Neue Module (Main-Prozess, `src/main/remote/`)

| Datei | Aufgabe | Vorbild/Reuse |
|---|---|---|
| `RemoteGateway.ts` | `node:http`-Server: Router, Auth-Middleware, Body-Cap, RateLimit, SSE-Hub, PWA-Shell ausliefern. `start/stopRemoteGateway()`. | `OrcaMcpServer.startMcpServer()`, `MAX_REQUEST_BODY_BYTES`, `readBody` |
| `gatewayHandle.ts` | Import-zyklusfreier Handle-/Port-Halter. | `orchestrator/mcpHandle.ts` |
| `deviceAuth.ts` | Pairing-Codes, Token-Mint (256-bit `randomBytes`), **nur Hash speichern**, `timingSafeEqual`-Prüfung, Widerruf, Geräte-Liste, Capabilities (`read`/`steer`/`admin`). | `node:crypto` |
| `deviceStore.ts` | `safeStorage`-verschlüsselte Geräte-Records + Push-Subs + VAPID + Cloudflare-Cred unter `secrets.remote.*`. | `config/secrets.ts` |
| `readModel.ts` | Abo auf `workspaceSessions.on('snapshot')`, letzter Snapshot je Session, SSE-Fan-out, `deriveApprovals()`. | `register.ts:487`-Muster |
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

## Geänderte Dateien (klein, additiv)

- `src/main/index.ts` — nach `startMcpServer()` ein guarded `startRemoteGatewayIfEnabled()`
  (nur wenn `remote.enabled === true`); `ORCA_REMOTE_SELFTEST`-Zweig neben
  `ORCA_MCP_SELFTEST` (`index.ts:38`); Gateway-/Tunnel-Teardown im `before-quit` (`index.ts:64`).
- `src/shared/ipc.ts` + `src/main/ipc/register.ts` + Preload — **desktop-only** `remote`-API:
  `remoteStatus`, `remoteEnable`, `remoteDisable` (Not-Aus), `remoteListDevices`,
  `remoteRevokeDevice`, `remotePairStart` (QR-Payload+Code) + Push-Kanal `evRemote`.
  Das Handy nutzt **nie** IPC, nur das Gateway.
- `src/main/config/configAccess.ts` — `remote.enabled` in die Public-Get/Set-Keys; `secrets.remote.*`
  bleibt durch `rejectSecretsKey` blockiert.
- `src/shared/orchestrator.ts` — `OrchestratorSnapshot` um `pendingApprovals: ApprovalItem[]`.
- `src/main/orchestrator/Engine.ts` — Approval-Items aus vorhandenen Gates ableiten; beim
  Parken den reservierten `waiting`-Status setzen (erste echte Nutzung).
- `electron.vite.config.ts` / Build + `package.json` — PWA-Build einhängen & mitliefern;
  ggf. QR-Lib. (`web-push` erst Phase B.)

## Befehls-Whitelist (streng, alles auf Bestehendes gemappt)

| Command | Args (zod) | Mapping | Berechtigung |
|---|---|---|---|
| `plan.approve` / `plan.reject` | `{profileId, sessionId, approved}` | `workspaceSessions.reviewPlan` (`register.ts:434`) | `steer` |
| `mode.enableAuto` | `{profileId, sessionId}` | `enableAutoMode` (`register.ts:428`) | `steer` |
| `run.reset` | `{profileId, sessionId}` | `reset` (`register.ts:424`) | `admin` |
| `goal.submit` | `{profileId, text}` | `createIdea` + `transferIdeaToProfile({…, yoloMaster:false})` (`transferService.ts:221`) | `steer`, hart rate-limitiert, **nie yolo** |
| `killSwitch.activate` | `{}` | Gateway-Stop + Tunnel-Stop + `revokeAll()` | `read` (jedes Gerät darf stoppen) |

**Niemals exponiert (mit Grund):** `agent.write` (Roh-PTY-stdin = RCE als Nutzer),
freies `spawn`/`spawnProfile` (frei wählbarer Provider/Dir/yolo = RCE), `agent.buffer`
(Scrollback enthält Quellcode/Tokens), jedes `config:set` und alle `secrets.*`,
Quality-Gate-Command-Strings (`autoPr.ts` nutzt `shell`), Provider-Login/OAuth, Datei-/
Ordner-Picker. **Regel:** ein Remote-Command darf nur strukturierte, zod-validierte,
größenbegrenzte Daten übergeben — nie einen Command-String, Pfad oder freien Provider-Selektor.

## Sicherheit (Kern)

- **Pairing:** Desktop mintet Einmal-Code (128-bit, TTL ≈ 5 min, single-use), zeigt QR mit
  Tunnel-URL. Handy postet `/pair {code, deviceName, pushSub?}`; Gateway prüft (constant-time,
  Pre-Auth-RateLimit) und gibt **einmalig** einen 256-bit-Token zurück. Gespeichert wird nur
  `sha256(token)` (via `safeStorage`) → eine gestohlene Config-Datei ergibt keine nutzbaren Tokens.
- **Pro Request:** `Authorization: Bearer <token>` im **Header** (nicht Query — verbessert
  bewusst `OrcaMcpServer.ts:516`); Hash + `timingSafeEqual` gegen nicht-widerrufene Geräte; sonst 401.
- **Widerruf & Not-Aus:** Einzelgerät widerrufen; „Alle widerrufen"; Master-Not-Aus stoppt
  Tunnel + Gateway und setzt persistent `remote.enabled=false`. Weil der Tunnel stirbt, ist der
  Origin binnen Sekunden unerreichbar, selbst wenn ein Token leakte. Dauerhaftes „Remote aktiv"-
  Warnsignal im Desktop (analog Yolo-Badge).
- **Audit-Log:** jede Auth/Command redigiert als JSONL (`0o600`, size-capped, `redactDiagnosticValue`);
  nie Token/Hash loggen, nur Geräte-ID. Export über bestehenden `diagnostics:exportLatest`-Dialog.
- **Härtung:** Body-Cap (Commands enger, z.B. 64 KB), RateLimit, strenge CSP/`nosniff`/`no-referrer`
  auf der Shell, **Host-Header-Allowlist** gegen DNS-Rebinding, `127.0.0.1`-Bind.
- **safeStorage nicht verfügbar** (Linux ohne Keyring, `secrets.ts:17` guard): Remote-Aktivierung
  wird **verweigert** (sicherer Default), mit klarer Meldung — kein Klartext-Fallback.

## Approval-Inbox (aus vorhandenen Gates)

`deriveApprovals(snapshots)` projiziert eine einheitliche Queue aus vorhandenen Snapshot-Feldern
— ohne CLI-Prompts abzufangen:
1. **Plan-Review** — `snapshot.pendingPlan` (`Engine.ts:466`); approve/reject → `reviewPlan`.
2. **Blockierter/needs-work-Task** — `status:'needs-work'|'error'` mit `recoveryArtifact`/`blocker`
   (`Engine.ts:900`); Aktion v1: `run.reset`/`mode.enableAuto`.
Beim Parken erhält der Task/Agent den `waiting`-Status → im DAG (Desktop **und** Handy) sichtbar
„wartet auf deine Entscheidung". Der **PR-Publication-Hold** (neuer `autoPr.mode:'hold-for-approval'`)
und der Echtzeit-**Per-Tool-Berechtigungs-Broker** (provider-spezifisch, brüchig) sind bewusst Phase B/C.

## Phasen

- **Phase A (MVP):** Gateway (127.0.0.1, Body-Cap, Host-Check) + SSE-Read-Model;
  Pairing (QR/Einmal-Code), 256-bit-Token hash-only, Header-Bearer, per-Gerät-/Master-Widerruf,
  Audit-Log; **Named Cloudflare Tunnel** (login/create/run) mit safeStorage-Cred; Approval-Inbox
  (Plan-Review + blockierte Tasks), `waiting` aktiv; PWA (Live-DAG + Inbox + freigeben) **inkl.
  `goal.submit`** (steer, non-yolo, rate-limitiert); Tests (§Verifikation). *Zurückgestellt:*
  WebSocket, Push, PR-Publication-Hold, `task.diff` über die Leitung.
- **Phase B:** Web-Push (`web-push`, VAPID in safeStorage, auf Transitions gedifft);
  `autoPr.mode:'hold-for-approval'` + `publication.approve/reject`; `task.diff` (redigiert,
  gedeckelt, capability-gated); optional Quick-Tunnel-Komfort.
- **Phase C (schwer, provider-abhängig):** Echtzeit-Per-Tool-Berechtigungs-Broker (MCP-Permission-Tool
  wo vorhanden, PTY-Prompt-Parsing sonst) + bidirektionaler `ws`-Pfad; Team-/Multi-User.

## Verifikation

- **Unit (Vitest, kolokiert):** `deviceAuth.test.ts` (Token-Entropie/Uniqueness, `timingSafeEqual`
  accept/reject, widerrufener Token, abgelaufener/replayter Code, **Roh-Token nie im Store**);
  `commands.test.ts` (jede Whitelist-ID resolved; unbekannt → 404; **Deny-List-Regression:**
  `agent.write`/`spawn`/`config.set` haben keine Route; zod lehnt Malformed ab);
  `auditLog.test.ts` (Redaktion von `Bearer`/`sk-`/`gh…`); `readModel.test.ts` (Approval-Projektion
  korrekt; SSE-Frame == Input-Snapshot); `rateLimit.test.ts`, `tunnelManager.test.ts`
  (URL-Parse aus `cloudflared`-stderr, Backoff, Kill); `configAccess`-Erweiterung (`secrets.remote.*` bleibt blockiert).
- **Integration:** `ORCA_REMOTE_SELFTEST=1` (nach `selftest.ts`-Muster): Gateway starten →
  unauth `GET /stream` = 401; pairen → guter Token 200 / schlechter 401; Engine mit gestubbtem
  `runTask` (`selftest.ts:105`) auf `pendingPlan` treiben → SSE-Frame prüfen → `POST /command
  {plan.approve}` löst auf (`snapshot().pendingPlan` leer); widerrufenes Gerät wird gedroppt;
  Audit-Einträge redigiert.
- **E2E (manuell):** `pnpm dev`, Remote aktivieren, Named-Tunnel läuft → QR am echten Handy
  scannen → Live-DAG spiegelt Desktop → Plan-Review-Lauf auslösen → in der Inbox freigeben →
  Ziel vom Handy senden → Desktop startet den Lauf → Not-Aus → Tunnel stirbt, Stream weg binnen Sekunden.
- **CI:** bestehendes `pnpm run ci` + neuer „remote"-UI-Smoke.

## Kritische Dateien
- `src/main/orchestrator/OrcaMcpServer.ts` — Auth/Body-Cap/`node:http`-Muster fürs Gateway.
- `src/main/ipc/register.ts` — `workspaceSessions.on('snapshot')`-Verdrahtung (Read-Model-Abo + Command-Home).
- `src/main/orchestrator/Engine.ts` — `push()`-Snapshot, `reviewPlan`/`pendingPlan`, `publishPendingChanges` (Gates + `waiting`).
- `src/main/config/secrets.ts` — safeStorage-Muster für Token/VAPID/Cloudflare-Cred.
- `src/main/diagnostics/runJournal.ts` — `redactDiagnosticValue` + JSONL-Writer fürs Audit-Log.
- `src/main/agents/resolveCommand.ts` + `src/shared/providers.ts` — `cloudflared`-Auflösung/Provider-Def.
- `src/shared/orchestrator.ts` — Typen, die die PWA direkt importiert (`OrchestratorSnapshot`/`PendingPlanReview`).
