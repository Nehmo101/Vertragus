# Native iPhone-App „Vertragus Mission Control" (SwiftUI)

> Implementierungs-Plan / Architektur-Blueprint für den nativen iOS-Client.
> Status: freigegeben und umsetzbereit. Rein additiv zum bestehenden Remote-Gateway.

## Context

Vertragus ist heute eine Electron-Desktop-App, die mehrere KI-Coding-Agenten
parallel orchestriert. Für die Fernsteuerung existiert bereits ein vollständiges,
sicherheitsgehärtetes **Remote-Gateway** (`src/main/remote/`) und eine
**mobile-first PWA „Mission Control"** (`apps/mobile/`). iOS wird bisher nur als
zum Home-Bildschirm hinzugefügte PWA erreicht — es gibt **keinen nativen iOS-Code**.

Ziel: eine **native SwiftUI-iPhone-App**, die den Agenten-Schwarm von überall live
beobachten, freigeben und steuern lässt. Sie ist ein **neuer, authentifizierter
Client gegen das bestehende Gateway** — das Backend existiert bereits, es wird nur
additiv um nativen APNs-Push erweitert. Kein Zweit-Zustand, keine Backend-Neubauten:
derselbe `OrchestratorSnapshot`-Stream, dieselbe Command-Whitelist, dieselben
Sicherheitsinvarianten wie bei der PWA.

## Getroffene Entscheidungen

| Frage | Entscheidung |
|---|---|
| Ansatz | **Native SwiftUI-App** (Vollportierung, kein Wrapper) |
| Umfang v1 | **Volle Parität** — alle fünf Screens der PWA + native Verbesserungen |
| Push | **APNs über den Desktop** — das Gateway sendet APNs direkt |

## Architektur-Überblick

```
 iPhone (SwiftUI)            Named Cloudflare Tunnel        Electron Main-Prozess
 ┌──────────────────┐  HTTPS      ┌──────────────┐  :127.0.0.1  ┌───────────────────────────┐
 │ RemoteClient     │◄──WS/SSE───►│  cloudflared │◄────────────►│ RemoteGateway (node:http) │
 │  (ObservableObj) │  POST /cmd  │  (outbound)  │              │  Auth · Whitelist · SSE   │
 │ 5 Tab-Views      │             │              │              │  PushService (+ APNs NEU) │
 │ APNs-Registrar   │◄──APNs──────┼──────────────┼──── api.push.apple.com ◄─── ES256-JWT     │
 └──────────────────┘             └──────────────┘              └───────────────────────────┘
```

- Base-URL = die öffentliche Tunnel-URL (`RemoteStatus.publicUrl`). **Neu gegenüber
  der PWA:** die App macht die Base-URL explizit/konfigurierbar (PWA nutzt
  Same-Origin-Relativpfade, weil sie vom Gateway ausgeliefert wird).
- Token nur im **Keychain**; Base-URL/Gerät in UserDefaults. Bearer im Header
  (HTTP) bzw. als WS-Subprotokoll `orca-bearer.<token>`.

---

## Teil 1 — Native iOS-App (`apps/ios/`)

Eigenständiges Xcode-Projekt im Monorepo neben `apps/mobile`. **Null
Drittanbieter-Abhängigkeiten** — nur Apple-Frameworks: SwiftUI, URLSession
(`URLSessionWebSocketTask`, `URLSession.bytes` für SSE), AVFoundation (QR-Scan +
Audio), UserNotifications, Security (Keychain). Deployment-Target **iOS 16+**.

### Projektstruktur
```
apps/ios/
  .gitignore                      # DerivedData, xcuserdata, *.xcuserstate
  README.md                       # Setup, Signing, wie man die Base-URL setzt
  MissionControl.xcodeproj        # (Alternativ: project.yml via XcodeGen für Text-Diff)
  MissionControl/
    App/VertragusApp.swift        # @main App + AppDelegate (APNs-Callbacks)
    Model/Contracts.swift         # Codable-Spiegel von remote.ts + orchestrator.ts
    Net/Endpoints.swift           # Base-URL + Pfad-Builder
    Net/RemoteClient.swift        # ObservableObject: Pairing, WS, SSE-Fallback, Commands
    Store/SecureStore.swift       # Keychain (Token) + UserDefaults (Base-URL, Device)
    Push/PushRegistrar.swift      # UNUserNotificationCenter, Token → POST /push/apns
    Views/PairView.swift          # QR-Scan + Code + Base-URL + Gerätename
    Views/RootView.swift          # TabView (5 Tabs) + Verbindungs-Badge
    Views/LiveView.swift          # DAG, Budget, pause/resume/fallback, replan, caps
    Views/InboxView.swift         # Approval-Karten (kind-spezifisch) + Diff-Viewer
    Views/ChangesView.swift       # Diff & Merge Center
    Views/GoalView.swift          # Ziel senden + Sprachaufnahme
    Views/DevicesView.swift       # Geräteliste, Push aktivieren, Master-Not-Aus
    Design/Theme.swift            # Farb-Tokens aus docs/BRAND.md (Light/Dark)
    Resources/Assets.xcassets     # AppIcon (aus build/icons/1024x1024.png), Farben
    Resources/de.lproj/Localizable.strings
    Resources/en.lproj/Localizable.strings
    Info.plist                    # Camera/Mic-Usage, UIBackgroundModes: remote-notification
```

### 1a. Contracts (`Model/Contracts.swift`)
Handportierte `Codable`-Structs, 1:1 gespiegelt aus den node-freien TS-Verträgen
(Kopfkommentar „Ported from src/shared/remote.ts + orchestrator.ts — keep in sync"):
- Aus **`src/shared/remote.ts`**: `RemoteCapability`, `RemoteCommandId`,
  `ApprovalKind`, `ApprovalItem`, `DeviceInfo`, `RemoteActor`, `RemoteScope`,
  `PermissionRequest`, `PairingResult`, `RemoteBudgetSnapshot`, `RemoteBudgetCaps`,
  `RemoteEventFrame` (als Swift-`enum` mit `type`-Diskriminator:
  `snapshot`/`approvals`/`event`/`ping`) + `command-result`-Frame.
- Aus **`src/shared/orchestrator.ts`** (nur was die UI rendert): `OrchestratorSnapshot`,
  `OrcaTask`, `TaskStatus`, `OrchestratorGoal`, `OrchestratorActivity`, `TaskBlocker`,
  `PendingPlanReview`, `ExecutionPlan`/`ExecutionPlanTask`, `IntegrationCenterSnapshot`,
  `IntegrationCenterItem`, `RemoteCiStatus`, `TaskPhase`.
- Optionale Felder als Swift-Optionals; unbekannte Felder ignorieren (robustes Decoding).
- Optional: `pnpm run gen:ios-contracts` (quicktype) als Regenerations-Hilfe —
  primär bleibt Handpflege, da der Vertrag klein und stabil ist.

### 1b. Networking (`Net/RemoteClient.swift`) — portiert aus `apps/mobile/src/App.tsx`
Ein `@MainActor final class RemoteClient: ObservableObject` mit `@Published`
`snapshots: [String: OrchestratorSnapshot]`, `approvals`, `devices`, `connected`, `error`:
- **Pairing:** `POST {base}/pair {code, deviceName}` → `PairingResult`; Token in Keychain,
  Gerät in UserDefaults. (Spiegelt `pair()` in App.tsx:243.)
- **Live-Kanal:** `URLSessionWebSocketTask` auf `wss://{host}/ws` mit Subprotokollen
  `["orca-v1", "orca-bearer.<token>"]` (Browser-Header-Limitierung entfällt nativ, wir
  folgen aber demselben Vertrag). Empfängt `RemoteEventFrame` + `command-result`.
- **SSE-Fallback:** `URLSession.bytes(for:)` auf `GET {base}/stream` mit Bearer-Header;
  `event:`/`data:`-Blöcke parsen (Logik aus `consumeSse()` App.tsx:65). Automatischer
  WS→SSE-Wechsel nach 2 Fehlschlägen; Exponential-Backoff, gedeckelt auf 30 s (wie App.tsx).
- **Commands:** über WS mit `requestId`-Korrelation (15 s Timeout), Fallback
  `POST {base}/command`. Exakte Argument-Shapes gemäß `src/main/remote/commands.ts`:
  `{profileId, sessionId}` (scope), `{profileId, text}` (goal), `+planId?`, `+taskId`,
  `+permissionId(uuid)`, `+maxTokens?/maxCostUsd?`, `+removeTaskIds[]/maxParallel?`.
- **Geräte:** `GET {base}/devices` → `[DeviceInfo]`.

### 1c. Screens (volle Parität mit `apps/mobile/src/App.tsx`)
Alle Aktionen **capability-gated** (spiegeln `capabilities.includes(...)` der PWA):
1. **PairView** — QR-Scan (`AVCaptureMetadataOutput` .qr) parst die Pairing-URL und
   extrahiert **Base-URL (Origin) + `code`** in einem Scan; plus manuelle Eingabe von
   Base-URL, Code, Gerätename. (QR-Payload heute: `${publicUrl}/#/pair?code=…`, siehe
   `index.ts:306`.)
2. **LiveView** — pro Workspace: Ziel, Budget-Karte (Token/Kosten/Caps/Telemetrie-
   Ehrlichkeit), `pendingPlan`-Wartehinweis, DAG-Task-Karten mit Status/Fortschritt;
   Aktionen `task.pause`/`task.resume`/`task.fallback`, `plan.replan`, `budget.setCaps`.
3. **InboxView** — `approvals`-Frame gerendert; kind-spezifische Aktionen
   (`plan.approve/reject`, `publication.approve/reject`, `permission.allow/deny`,
   `task.fallback`/`run.reset`, `mode.enableAuto`); `task.diff`-Viewer (read-only).
4. **ChangesView** — Diff & Merge Center aus `snapshot.integration`; `task.diff` je Item,
   `publication.approve/reject`.
5. **GoalView** — Workspace-Picker (nur Profile mit `allowGoalSubmit`), Ziel-Textfeld
   (max 8000), **Sprachaufnahme** (`AVAudioRecorder` → base64 → `POST {base}/speech/transcribe`),
   dann `goal.submit` (serverseitig immer `yoloMaster:false`).
6. **DevicesView** — Geräteliste, „Push aktivieren" (native Registrierung, s. 1d),
   **Master-Not-Aus** (`killSwitch.activate`).

### 1d. Native Push-Registrierung (Client-Seite)
`Push/PushRegistrar.swift`: `UNUserNotificationCenter.requestAuthorization` →
`UIApplication.registerForRemoteNotifications` → im `AppDelegate`
`didRegisterForRemoteNotificationsWithDeviceToken` das APNs-Device-Token (hex) an das
Gateway senden: **neuer Endpoint** `POST {base}/push/apns { token, environment, bundleId }`
(Capability `push`). `didReceiveRemoteNotification`/`UNUserNotificationCenterDelegate`
öffnet den Deep-Link aus `transition.url` (z. B. `/#/approvals` → Inbox-Tab).

### 1e. Design & Lokalisierung
- Farb-Tokens aus **`docs/BRAND.md`** in `Assets.xcassets` (Light/Dark): Bronze `#CBA35A`/
  `#936C2B`, Verdigris `#2F7D6D`/`#1E5148`, Graphit `#20242B`, Vellum `#EDE8DD`.
  Visuelle Sprache/Statusfarben aus `apps/mobile/src/styles.css` übernehmen.
- **AppIcon** aus vorhandenem `build/icons/1024x1024.png` (bereits App-Store-Größe).
- **Deutsch-first, Englisch-Fallback**: `Localizable.strings` aus den `remote.*`-Keys von
  `src/renderer/src/locales/{de,en}.json` + den hartcodierten deutschen PWA-Strings als
  fertigem Copy-Deck.

---

## Teil 2 — Serverseitige APNs-Erweiterung (Desktop, rein additiv)

Der Desktop ist der Push-Sender (P2P-Modell, kein zentraler Server). APNs-Signierdaten
werden — wie die Cloudflare-Credentials heute — als **verschlüsseltes Desktop-Secret**
vom Nutzer konfiguriert (nicht im Binary ausgeliefert; das ist der ehrliche Open-Source-
Pfad und löst die Schlüsselverteilungsfrage: wer Push will, hinterlegt sein eigenes
Apple-APNs-Schlüsselpaar). Bestehender Web-Push-Pfad bleibt unverändert für die PWA.

| Datei | Änderung | Vorbild/Reuse |
|---|---|---|
| `src/main/remote/apnsSender.ts` **(NEU)** | Lazy-geladener HTTP/2-Sender: ES256-Provider-JWT (`node:crypto`) + `node:http2` POST an `api.push.apple.com`/`api.sandbox.push.apple.com`; `410 BadDeviceToken` → Token prunen. Als Interface abstrahiert (wie `WebPushModule`). | `pushService.ts` `WebPushModule`-Abstraktion |
| `src/main/remote/deviceStore.ts` | `StoredApnsToken` (`{id, deviceId, token, environment, bundleId, createdAt}`) + `secrets.remote.apnsTokens` read/write; `StoredApnsCredential` (`{teamId, keyId, p8, bundleId, environment}`) + `secrets.remote.apns` read/write. | `readEncryptedJson`/`writeEncryptedJson`, `readCloudflareCredential`, `StoredPushSubscription` |
| `src/main/remote/pushService.ts` | Liefert Transitions zusätzlich an APNs-Tokens (scope-gefiltert via `canRead`); `subscribeApns(deviceId, token…)`; `removeDevice`/`removeAll` prunen auch APNs. `PushTransition` (`{title, body, url, …}`) direkt auf APNs-`alert`+`data` mappen. | vorhandene `deliver()`/`diffPushTransitions` (unverändert wiederverwenden) |
| `src/main/remote/RemoteGateway.ts` | Route `POST /push/apns` (Capability `push`, Body-Cap) → `pushService.subscribeApns`. | vorhandene `/push/subscribe`-Route |
| `src/main/remote/index.ts` | PushService mit APNs-Deps konstruieren (Credential lazy laden); `auth.on('revoked')` prunt APNs automatisch (bestehender `push.removeDevice`-Aufruf). | `RemoteService`-Konstruktor (Zeile 55, 127) |
| `src/shared/remote.ts` | Typen `ApnsRegisterRequest`/`ApnsEnvironment`; `RemoteEnableRequest` bleibt unangetastet (APNs-Config läuft über eigene IPC). | vorhandene Contract-Datei |
| `src/shared/ipc.ts` + `src/main/ipc/register.ts` + Preload + `src/renderer/src/components/RemotePanel.tsx` | **Desktop-only** IPC `remote:setApnsConfig`/`remote:getApnsConfigStatus` (Team-ID, Key-ID, `.p8`-Datei, Bundle-ID, Sandbox/Prod) → verschlüsselt speichern; kleine Config-UI im RemotePanel. Handy nutzt nie IPC. | `remote:*`-IPC-Muster, `writeAccessConfig` |
| `package.json` | Optionale, **lazy** APNs-Dep nur falls kein Hand-Roll gewünscht — Standard: kein neues Paket, ES256+HTTP/2 mit Node-Builtins. | Repo-Prinzip „dependency-arm" |

**Erhaltene Sicherheitsinvarianten (aus `docs/MISSION_CONTROL_PLAN.md`):** APNs-Config
bleibt in `secrets.remote.*` (durch `rejectSecretsKey` von Public-Config-Zugriff geblockt),
safeStorage-Pflicht, Auditierung jedes Versands (bestehendes `push.on('delivery')`-Audit in
`index.ts:115`), Prune bei Widerruf/Not-Aus, Body-Caps/Host-Allowlist/Bearer-Auth unverändert.

---

## Teil 3 — Build, CI, Distribution

- **`apps/ios/README.md`**: Xcode-Setup, Signing (eigenes Apple-Developer-Team/Bundle-ID),
  wie man die Base-URL auf die Tunnel-URL setzt, wie man APNs-Config im Desktop hinterlegt.
- **`pnpm-workspace.yaml` prüfen**: sicherstellen, dass das Glob nicht `apps/*` (ohne
  `package.json`) erfasst und `pnpm install` an `apps/ios` scheitert — ggf. auf `apps/mobile`
  einschränken bzw. `apps/ios` ausschließen. **(Vor der Implementierung verifizieren.)**
- **`.github/workflows/ios.yml` (NEU, optional)**: macOS-Runner, `xcodebuild build`/`test`
  des `MissionControl`-Schemas (unsigniert). Blockiert das bestehende `pnpm run ci` nicht.
- **Distribution**: TestFlight/App Store über ein Apple-Developer-Konto (Signing lokal/CI).
  Für Selbst-Hoster im README: eigenes Bundle + eigenes APNs-Schlüsselpaar.

---

## Kritische Dateien (Referenz)

**Neu (iOS):** gesamtes `apps/ios/` (s. Struktur oben).
**Neu (Server):** `src/main/remote/apnsSender.ts`.
**Geändert (Server, klein/additiv):** `deviceStore.ts`, `pushService.ts`,
`RemoteGateway.ts`, `index.ts`, `src/shared/remote.ts`, `ipc.ts`, `ipc/register.ts`,
Preload, `RemotePanel.tsx`.
**Reuse-Anker (nur lesen/spiegeln, nicht ändern):** `src/shared/remote.ts`,
`src/shared/orchestrator.ts` (Contract), `apps/mobile/src/App.tsx` (Referenz-Client-Logik),
`src/main/remote/commands.ts` (Command-Argument-Schemas), `apps/mobile/src/styles.css` +
`docs/BRAND.md` (Design), `build/icons/1024x1024.png` (App-Icon).

## Verifikation (End-to-End)

**Swift-Unit-Tests (XCTest):** Decoding echter `snapshot`/`approvals`/`command-result`-
Frames (Fixtures aus einem echten Gateway-Stream); Command-Envelope-Encoding == zod-Schemas
aus `commands.ts`; SSE-Frame-Parser; Keychain/Base-URL-Persistenz; QR-URL-Parsing
(Origin + `code` korrekt extrahiert).

**Server-Unit-Tests (Vitest, neben bestehenden `*.test.ts`):** ES256-JWT-Signatur
(Header/Claims/`alg`); `subscribeApns` speichert/entdupliziert; `removeDevice`/`removeAll`
prunen APNs-Tokens; Transition→APNs-Payload-Mapping; `410`→Prune; `secrets.remote.apns`
bleibt aus Public-Config geblockt (Regression wie im Plan-Doc gefordert).

**Integration/E2E (manuell, echtes Gerät oder Simulator):**
1. `corepack pnpm dev` → Remote aktivieren (Quick-Tunnel), APNs-Config in Settings hinterlegen.
2. App starten → Base-URL = Tunnel-URL → QR scannen (oder Code eintippen) → **pairen**.
3. Live-DAG spiegelt den Desktop; Plan freigeben, Ziel senden (inkl. Sprache), Diff ansehen,
   Budget-Caps setzen, Task pausieren/fortsetzen.
4. Eine Transition auslösen (z. B. Plan wartet, PR geöffnet) → **APNs-Notification** kommt an
   → Tippen deep-linkt in die Inbox.
5. **Master-Not-Aus** → Live-Stream reißt binnen Sekunden ab (Tunnel+Gateway down).
6. Gateway-Regression: `ORCA_REMOTE_SELFTEST=1` (bestehender Integrationstest) bleibt grün;
   `corepack pnpm run ci` unverändert grün (iOS ist außerhalb der pnpm-CI).

## Nicht im Umfang (v1) / Folgeschritte
- Android-Client (dieselbe Architektur, FCM statt APNs).
- Vertrags-Codegen-Pipeline TS→Swift automatisiert (v1: Handpflege mit Kopfkommentar).
- App-Store-Einreichung/Review-Assets (Screenshots, Datenschutz) — separater Schritt.

## Offene Annahmen
- Xcode-Projekt als reguläres `.xcodeproj` (Alternative XcodeGen `project.yml` für
  text-diffbare Reviews — bei Wunsch umstellbar).
- Ein Apple-Developer-Konto/Bundle-ID steht für Signing & APNs-Schlüssel bereit; ohne
  APNs-Config läuft die App voll funktionsfähig, nur ohne Hintergrund-Push (In-App-
  Live-Badges greifen dann wie bei der PWA).
