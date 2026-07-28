# IPC-Architektur: Kanal-Manifest als Single Source of Truth

Stand: 28. Juli 2026 · Audit-Punkt A4 — **Manifest umgesetzt: 116 von 116
Renderer→Main-Kanälen laufen über das Manifest (0 Legacy-Kanäle)**, dazu alle
11 Push-Events und 1 Preload-lokales API-Mitglied.

Die IPC-Oberfläche von Vertragus umfasst **127 Kanäle** (108 Request/Response,
8 Einweg-Sends Renderer→Main, 11 Push-Events Main→Renderer). Die frühere
Dreifachpflege (Konstanten/Typen, Preload-Bridge, Handler-Registrierung — je
Kanal drei Stellen) ist abgelöst: Ein **deklaratives Kanal-Manifest** in
`src/shared/ipcManifest.ts` beschreibt jeden Kanal genau einmal; Preload-Bridge
und Handler-Verdrahtung werden daraus generisch aufgebaut. Drift zwischen den
Schichten ist damit **per Konstruktion** ausgeschlossen; der Guard-Test sichert
die verbliebenen Freiheitsgrade (Autorisierungs-Deklarationen, Handler-Bodies,
Ausnahmen) ab.

## Die Schichten heute

| Schicht | Datei | Inhalt |
| --- | --- | --- |
| Namen + Typen | `src/shared/ipc.ts` | `IPC`-Konstantenobjekt (Kanalname → String) und das `VertragusApi`-Interface, das der Renderer unter `window.vertragus` sieht. Bleibt die Heimat der Kanal-Strings und API-Signaturen. |
| **Manifest** | `src/shared/ipcManifest.ts` | **Je Kanal EIN Eintrag**: Kanal (via `IPC`-Konstante), Richtung (`invoke` \| `send` \| `event` \| `local`), API-Pfad auf `window.vertragus`, Autorisierungs-Stufe, Validierungsmodus, Sonderfall-Markierung (`bridge: 'custom'`), Begründungs-`note`. Zod-frei und Electron-frei (Preload-Bundle). Enthält außerdem `buildVertragusApi` (generischer Preload-Builder). |
| Schema-Bindings | `src/shared/ipcManifestSchemas.ts` | Zod-Schema + deutsches Fehlerlabel je Kanal mit `validation: 'schema'` (11 Kanäle). Nur der Main-Prozess importiert dieses Modul (Preload bleibt zod-frei). |
| Bridge | `src/preload/index.ts` | Baut `window.vertragus` via `buildVertragusApi(transport, customBindings)`. Nur die 4 `bridge: 'custom'`-Einträge sind handgeschrieben (s. u.). |
| Registrierung | `src/main/ipc/registerManifest.ts` | `registerManifestChannels`: Schleife über das Manifest — zentrale Autorisierung + zentraler zod-Parse VOR dem Handler, dann `ipcMain.handle`/`ipcMain.on`. |
| Handler | `src/main/ipc/register.ts` | Die typisierte `ManifestHandlers`-Map (eine Implementierung je invoke/send-Kanal, Argument-/Ergebnistypen aus `VertragusApi` abgeleitet) plus die Push-Event-Verdrahtung (`broadcast(IPC.ev…)`). |

### Typsicherheit

Jeder Manifest-Eintrag trägt als Phantom-Typ das `VertragusApi`-Mitglied seines
API-Pfads (`ApiAtPath<'agents.spawn'>` etc.) — Manifest und `ipc.ts`-Typen
können nicht divergieren. Zwei statische Checks in `ipcManifest.ts` erzwingen
Vollständigkeit in beide Richtungen (`_EveryApiMemberHasAManifestEntry`,
`_EveryManifestEntryTargetsARealApiMember`): ein neues `VertragusApi`-Mitglied
ohne Manifest-Eintrag ist ein Compile-Fehler, ebenso ein Manifest-Eintrag auf
einen nicht existierenden Pfad. Die `ManifestHandlers`-Map in `register.ts`
und die Schema-Map in `ipcManifestSchemas.ts` sind Mapped Types über das
Manifest — fehlende oder überzählige Handler/Schemas sind Compile-Fehler.

### Kanal-Klassen (Namenskonvention, unverändert)

- **Request/Response** (`kind: 'invoke'`): z. B. `profiles:list`, `agent:spawn`.
- **Einweg Renderer→Main** (`kind: 'send'`): heiße bzw. rückgabefreie Pfade —
  `agent:write`, `agent:resize`, `win:*`, `voiceOverlay:moved`, `attention:setPendingFeedbackCount`.
- **Push Main→Renderer** (`kind: 'event'`): Präfix **`ev:`** — Konvention *und*
  vom Guard erzwungen.
- **`kind: 'local'`**: Preload-lokal, kein IPC (nur `files.pathForFile` via `webUtils`).

### Autorisierungs-Stufen (`auth`)

Zentral von `registerManifestChannels` durchgesetzt, **bevor** der Handler läuft:

| Stufe | Verhalten | Anzahl |
| --- | --- | --- |
| `'any'` | bewusst aus jedem Fenster erreichbar; `note` mit Begründung ist Pflicht (Guard) | 52 |
| `'not-voice'` | verweigert das Voice-Overlay (invoke: wirft, send: still verworfen) | 38 |
| `'main-window'` | nur Hauptfenster (wirft) | 13 |
| `'voice-window'` | nur Voice-Overlay (send: andere Sender still verworfen) | 1 |
| `'controller'` | ein Controller im Handler prüft die Sender-Herkunft selbst (`create…IpcController`) | 10 |
| `'custom'` | maßgeschneiderter Guard im Handler (`guardVoiceTurnAllowed`, `guardOverlayControl`) | 2 |

### Validierungsmodi (`validation`)

- `'schema'` (11 Kanäle): zentraler `parseIpcPayload`-zod-Parse via
  `ipcManifestSchemas.ts`; `schemaArg` wählt das Argument (Standard 0,
  `ideas:addArtifact` parst Argument 1), `schemaOptional` lässt `undefined`
  durch (`ideas:create`). Der Handler erhält das geparste (gestrippte) Payload.
- `'handler'`: der Handler-Body validiert (Shared-Asserts wie `assertIpcId`,
  Controller oder der Service dahinter). Der Guard verlangt einen
  Validierungs-Marker im Body **oder** einen begründeten Eintrag in
  `VALIDATION_EXCEPTIONS` (aktuell 24, u. a. die dokumentierte
  `profile:generateForRepo`-Drift).
- `'none'`: Kanal ohne Renderer-Payload (Guard: Handler nimmt maximal den
  Event-Parameter).

### Preload-Sonderfälle (`bridge: 'custom'`, 4 Stück)

1. `configGet` / `configSet` — validieren den Config-Key schon im Preload
   (fail fast; Main validiert erneut).
2. `ideasAbortPromptEnhancement` — wickelt die nackte `requestId` in die
   `{ requestId }`-Request-Form des Controllers.
3. `files.pathForFile` — kein IPC, `webUtils.getPathForFile` direkt im Preload.

Dazu ein dokumentierter Event-Alias: `voiceAssistant.onProgress` abonniert
denselben Kanal wie `events.onVoiceAssistant` (`ev:voiceAssistant`).

## Die Guards

- **`src/main/ipc/ipcSurface.test.ts`** (Quell- + Manifest-Guard): Manifest ↔
  `IPC`-Konstanten 1:1 (gleiche Keys, gleiche Strings, `ev:`-Konvention,
  keine Kanal-Duplikate außer deklarierten Event-Aliassen); Handler-Map deckt
  exakt die registrierbaren Manifest-Kanäle; `'controller'`/`'custom'`-Kanäle
  zeigen ihren Marker im Body; die **exakten Mengen** der `'any'`-,
  `'main-window'`-, `'controller'`-, `'custom'`- und `'voice-window'`-Kanäle
  sind als Review-Listen gepinnt (einen Kanal zu öffnen erfordert eine
  Test-Änderung); `VALIDATION_EXCEPTIONS` mit Rot-Schutz (stale Einträge
  schlagen fehl); Push-Events ↔ `broadcast`-Verwendung; Preload referenziert
  `IPC.*` nur für seine Custom-Bindings; **Legacy-Welt**: direkte
  `ipcMain.handle(IPC.…)`-Registrierungen in `register.ts` müssen in
  `LEGACY_CHANNELS` deklariert sein (derzeit leer), dürfen nie mit dem Manifest
  kollidieren (keine Doppelregistrierung) und müssen die alten
  Marker-Muster erfüllen; Plausibilitäts-Untergrenzen.
- **`src/main/ipc/registerManifest.test.ts`** (Verhaltens-Guard): die zentrale
  Pipeline weist Voice-/Fremdfenster nach Stufe ab bzw. verwirft still,
  parst Schemas (inkl. `schemaArg`/`schemaOptional`, Auth vor Parse) und
  registriert jeden invoke/send-Kanal genau einmal auf dem richtigen
  `ipcMain`-Primitive.
- **`src/shared/ipcManifest.test.ts`**: der generische Builder reicht
  Argumente durch, Events liefern funktionierende Unsubscribes, fehlende
  Custom-Bindings werfen, API-Pfade sind eindeutig.
- **`register.channels.test.ts`** (Tippfehler/Doppelregistrierung, kein
  direktes `ipcMain` in `register.ts`) und **`register.attention.test.ts`** /
  **`register.voiceAuth.test.ts`** (Spezialverdrahtung + gepinnte
  `not-voice`-Deklarationen mit Verhaltens-Spotcheck) ergänzen.

## Neuen Kanal anlegen — Schritt für Schritt

Beispiel: ein Request/Response-Kanal `github:listIssues` unter
`window.vertragus.github.listIssues`.

1. **`src/shared/ipc.ts`** — Konstante + API-Methode ergänzen (unverändert die
   Heimat von Namen und Typen):

   ```ts
   export const IPC = {
     // …
     githubListIssues: 'github:listIssues',
   } as const

   export interface VertragusApi {
     github: {
       listIssues(req: GithubIssueListRequest): Promise<GithubIssueListResult>
     }
   }
   ```

2. **`src/shared/ipcManifest.ts`** — EIN Manifest-Eintrag (gleicher Key wie die
   `IPC`-Konstante; ab hier meldet der Compiler jede fehlende Stelle):

   ```ts
   githubListIssues: invoke(IPC.githubListIssues, 'github.listIssues', {
     auth: 'not-voice',      // 'any' nur mit note + Eintrag in EXPECTED_OPEN_CHANNELS des Guards
     validation: 'schema'
   }),
   ```

3. **`src/shared/ipcSchemas.ts` + `src/shared/ipcManifestSchemas.ts`** — bei
   `validation: 'schema'` das zod-Schema anlegen und binden:

   ```ts
   githubListIssues: { label: 'Issue-Anfrage', schema: githubIssueListRequestSchema },
   ```

4. **`src/main/ipc/register.ts`** — Handler in die `manifestHandlers`-Map
   (Payload kommt bereits geparst an, Autorisierung läuft zentral):

   ```ts
   githubListIssues: (_e, req) => listOpenIssues(req),
   ```

5. **`vitest` laufen lassen.** Preload-Bridge entsteht automatisch — es gibt
   keinen Preload-Schritt mehr. Compilerfehler benennen fehlende
   Manifest-/Handler-/Schema-Einträge; der Guard meldet fehlende Begründungen
   (`note` bei `auth: 'any'`) und nicht gepinnte Autorisierungs-Mengen. Nur
   wenn eine Abweichung **gewollt** ist (Validierung im Service, offener
   Read-only-Kanal), den Kanal mit Begründung in die passende Liste in
   `ipcSurface.test.ts` eintragen.

Für Push-Events: `ev:`-Konstante in `ipc.ts`, `onX`-Signatur im `VertragusApi`,
`event(IPC.evX, 'gruppe.onX')`-Eintrag im Manifest, `broadcast(IPC.evX, …)` in
`register.ts`. Für Preload-Sonderformen (Argument-Transformationen): Eintrag
mit `bridge: 'custom'` markieren und Binding in `customBindings`
(`src/preload/index.ts`) ergänzen.

## Restliste + bekannte Drift

- **Legacy-Kanäle: keine.** Alle 116 Renderer→Main-Kanäle laufen übers
  Manifest; `LEGACY_CHANNELS` im Guard ist leer und existiert als
  dokumentierter Ausweg für künftige Sonderfälle (alter Pfad bleibt vom Guard
  überwacht und kollisionsfrei).
- **`profile:generateForRepo`** nimmt sein Request-Objekt weiterhin ohne
  zod-Parse an der IPC-Grenze entgegen (Validierung erst in
  `generateProfileForRepo`) — als `DRIFT` in `VALIDATION_EXCEPTIONS` markiert
  und im Manifest-`note` dokumentiert; Kandidat für `validation: 'schema'`.
- **~24 `validation: 'handler'`-Kanäle ohne Shared-Marker** (inline-`typeof`,
  Service-Validierung, `String()`/`Boolean()`-Koersion) stehen begründet in
  `VALIDATION_EXCEPTIONS` — unverändert gegenüber dem Stand vor dem Manifest.
- **`windows.ts` / `pushDemoState`** sendet weiterhin mit String-Literalen
  (`'ev:agentsChanged'` …) statt über die `IPC`-Konstanten; der Guard prüft die
  Literale gegen die Konstanten.
- **Voice-Overlay-Reichweite:** Die Inbox-Mutationskanäle (`ideas:*`,
  `inboxSpeech:*`) bleiben bewusst aus jedem Fenster aufrufbar
  (`auth: 'any'` mit Begründungs-`note`, gepinnt in `EXPECTED_OPEN_CHANNELS`).
