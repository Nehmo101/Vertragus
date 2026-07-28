# IPC-Architektur: die dreifach gepflegte Oberfläche und ihr Konsistenz-Guard

Stand: 28. Juli 2026 · Audit-Punkt A4 („IPC surface maintained in triplicate")

Die IPC-Oberfläche von Vertragus umfasst aktuell **127 Kanäle** (108 Request/Response,
8 Einweg-Sends Renderer→Main, 11 Push-Events Main→Renderer). Jeder Kanal wird an
**drei Stellen** gepflegt. Drift zwischen den dreien fiel bisher erst zur Laufzeit auf —
seit diesem Schritt fängt ein statischer Guard-Test die typischen Fehlerklassen beim
`vitest`-Lauf ab.

## Die drei Schichten

| Schicht | Datei | Inhalt |
| --- | --- | --- |
| 1. Vertrag | `src/shared/ipc.ts` | `IPC`-Konstantenobjekt (Kanalname → String) plus das `VertragusApi`-Interface, das der Renderer unter `window.vertragus` sieht. |
| 2. Bridge | `src/preload/index.ts` | `contextBridge`-Expose des `VertragusApi`: `ipcRenderer.invoke(IPC.…)` für Request/Response, `ipcRenderer.send(IPC.…)` für Einweg-Kanäle, `subscribe(IPC.ev…)` für Push-Events. |
| 3. Handler | `src/main/ipc/register.ts` | `ipcMain.handle(IPC.…)` / `ipcMain.on(IPC.…)` mit Autorisierung (Fenster-Guards) und Payload-Validierung (zod / Shared-Asserts). Push-Events werden hier via `broadcast(IPC.ev…)` bzw. `sender.send(…)` verschickt. |

### Kanal-Klassen (Namenskonvention)

- **Request/Response** (`invoke`/`handle`): z. B. `profiles:list`, `agent:spawn`.
- **Einweg Renderer→Main** (`send`/`on`): heiße bzw. rückgabefreie Pfade —
  `agent:write`, `agent:resize`, `win:*`, `voiceOverlay:moved`, `attention:setPendingFeedbackCount`.
- **Push Main→Renderer**: Präfix **`ev:`** (z. B. `ev:agentsChanged`). Das Präfix ist
  Konvention *und* wird vom Guard erzwungen: `invoke`-Kanäle dürfen nicht `ev:` heißen,
  gepushte Kanäle müssen es.

### Sicherheitsmuster in `register.ts`

Alle Fenster (Hauptfenster, Agent-Pop-outs, Voice-Overlay) teilen sich dasselbe Preload,
d. h. **jeder Kanal ist grundsätzlich aus jedem Fenster aufrufbar**. Privilegierte Kanäle
schützen sich deshalb explizit:

- **Autorisierung:** `assertNotVoiceWindow(e)` (verweigert das Voice-Overlay),
  `requireMainWindow(e)` (nur Hauptfenster), `guardVoiceTurnAllowed` / `guardOverlayControl`
  (Voice-Spezialfälle) oder ein Controller (`create…IpcController`), der Sender-Herkunft
  selbst prüft.
- **Validierung:** `parseIpcPayload(zodSchema, payload, 'Label')` für strukturierte
  Payloads, `assertIpcId` / `assertIpcOptionalId` / `assertValidConfigKey` für String-IDs,
  `requireProfile(profileId)` für Profil-Bezüge.

Nicht jeder Kanal braucht beides — Read-only-Kanäle ohne Payload (z. B. `profiles:list`)
sind bewusst ungeschützt. Der Guard verlangt aber, dass jede Abweichung **explizit mit
Begründung** gelistet ist.

## Der Konsistenz-Guard: `src/main/ipc/ipcSurface.test.ts`

Der Guard liest die drei Quelldateien (plus `src/main/windows.ts`), leitet **alle
Kanal-Mengen programmatisch aus den Quellen ab** (keine hartkodierte Vollliste — rein
additive Erweiterungen, die dem Muster folgen, bleiben automatisch grün) und prüft:

1. **(a) Invoke → Handler:** Jeder im Preload invokete/gesendete Kanal hat einen
   registrierten `ipcMain.handle`/`ipcMain.on`-Handler.
2. **(b) Handler → Invoke:** Jeder registrierte Handler wird im Preload verwendet —
   tote Handler fallen sofort auf (Ausnahmen: `HANDLERS_WITHOUT_PRELOAD_USE`, derzeit leer).
3. **(c) Autorisierung + Validierung:** Jeder Handler-Block zeigt einen
   Autorisierungs-Marker; jeder Handler mit Payload-Parametern zeigt einen
   Validierungs-Marker. Abweichungen stehen mit Begründung in `AUTH_EXCEPTIONS`
   (~52 bewusst fensteroffene, meist Read-only-Kanäle) bzw. `VALIDATION_EXCEPTIONS`
   (~23 Kanäle, die inline oder im Service dahinter validieren). Ein Hygiene-Test
   entfernt veraltete Einträge: Wird ein Ausnahme-Kanal später korrekt geschützt,
   schlägt der Test fehl, bis der Eintrag gelöscht ist — die Listen können nicht verrotten.
4. **(d) Events:** Jeder aus `register.ts` gepushte `ev:`-Kanal hat einen
   Preload-Subscriber und umgekehrt; die `ev:`-String-Literale in
   `windows.ts` (`pushDemoState`) müssen auf echte Kanäle zeigen.

Daneben: eindeutige Kanal-Strings (kein Alias), keine Waisen-Konstanten, kein Kanal
gleichzeitig `handle` und `on`, Plausibilitäts-Untergrenzen gegen Parser-Rot.
Ergänzend prüfen `register.channels.test.ts` (Tippfehler/Doppelregistrierung) und
`register.attention.test.ts` (Attention-Spezialverdrahtung) weitere Invarianten.

## Neuen Kanal anlegen — Schritt für Schritt

Beispiel: ein Request/Response-Kanal `github:listIssues`.

1. **`src/shared/ipc.ts`** — Konstante + API-Methode ergänzen:

   ```ts
   export const IPC = {
     // …
     githubListIssues: 'github:listIssues',
   } as const

   export interface VertragusApi {
     // …
     githubListIssues(dir: string): Promise<GithubIssueSummary[]>
   }
   ```

2. **`src/preload/index.ts`** — Bridge-Methode:

   ```ts
   githubListIssues: (dir) => ipcRenderer.invoke(IPC.githubListIssues, dir),
   ```

3. **`src/main/ipc/register.ts`** — Handler mit Autorisierung + Validierung:

   ```ts
   ipcMain.handle(IPC.githubListIssues, (e, dir: unknown) => {
     assertNotVoiceWindow(e) // entfällt nur bei bewusst offenen Read-only-Kanälen
     return listGithubIssues(assertIpcId(dir, 'Verzeichnisangabe', 4096))
   })
   ```

   Für strukturierte Payloads stattdessen ein zod-Schema in `src/shared/ipcSchemas.ts`
   anlegen und mit `parseIpcPayload(schema, payload, 'Label')` parsen.

4. **`vitest` laufen lassen.** Der Guard ist grün, sobald alle drei Schichten das Muster
   erfüllen. Fehlt ein Schritt (z. B. Handler ohne Preload-Methode oder ohne
   Autorisierungs-Marker), benennt die Fehlermeldung den Kanal und die erwartete
   Korrektur. Nur wenn die Abweichung **gewollt** ist (Read-only, Validierung im
   Service), den Kanal mit einem Begründungssatz in die passende Ausnahme-Liste
   in `ipcSurface.test.ts` eintragen.

Für Push-Events analog: `ev:`-Konstante, `subscribe(IPC.ev…)`-Methode im Preload,
`broadcast(IPC.ev…)` im Main-Prozess.

## Bekannte Drift (dokumentiert, bewusst nicht „mitrepariert")

- **`profile:generateForRepo`** nimmt sein Request-Objekt ohne zod-Parse an der
  IPC-Grenze entgegen (Validierung erst in `generateProfileForRepo`) — als `DRIFT`
  in `VALIDATION_EXCEPTIONS` markiert; Kandidat für ein Schema in `ipcSchemas.ts`.
- **`windows.ts` / `pushDemoState`** sendet mit String-Literalen (`'ev:agentsChanged'` …)
  statt über die `IPC`-Konstanten. Der Guard prüft die Literale gegen die Konstanten,
  besser wäre die direkte Verwendung von `IPC.ev…`.
- **Voice-Overlay-Reichweite:** Die Inbox-Mutationskanäle (`ideas:create/update/delete`, …)
  und `inboxSpeech:*` sind aus jedem Fenster aufrufbar (kein Fenster-Guard). Für die
  Inbox ist das vertretbar (validierte, unprivilegierte Ablage), steht aber bewusst
  sichtbar in `AUTH_EXCEPTIONS`, damit die Entscheidung überprüfbar bleibt.
- Tote Handler oder unbenutzte Kanäle gibt es derzeit **keine** — alle 127 Konstanten
  sind in Preload und Register verdrahtet.

## Empfohlener Folgeschritt: Kanal-Manifest als Single Source of Truth

Der Guard verhindert Drift, beseitigt aber nicht die Dreifachpflege. Der nächste
A4-Schritt wäre ein **deklaratives Kanal-Manifest** in `src/shared/` (kein Voll-Codegen):

```ts
// src/shared/ipcManifest.ts (Skizze)
export const ipcManifest = {
  githubListIssues: {
    channel: 'github:listIssues',
    kind: 'invoke',            // 'invoke' | 'send' | 'event'
    auth: 'notVoiceWindow',    // 'none' | 'notVoiceWindow' | 'mainWindow' | 'controller'
    schema: githubListIssuesRequestSchema // zod; Typen via z.infer abgeleitet
  },
  // …
} as const
```

Daraus ableitbar:

1. **Typen:** `VertragusApi`-Signaturen via `z.infer` aus den Schemas — Schicht 1 entfällt
   als eigene Pflegestelle weitgehend.
2. **Preload:** eine generische Schleife baut `invoke`/`send`/`subscribe`-Methoden aus dem
   Manifest (die heutige Datei schrumpft auf Sonderfälle wie `files.pathForFile`).
3. **Register:** ein Wrapper `registerChannel(manifestEntry, handlerFn)` erzwingt
   Auth-Guard + zod-Parse zentral; `register.ts` behält nur noch die Handler-Logik.
4. Der bestehende Guard bleibt als Rückversicherung und prüft dann Manifest ↔ Quellen.

**Aufwandsschätzung** (inkrementell, pro Domäne migrierbar — z. B. zuerst `retro:*`/`win:*`):

| Teilschritt | Aufwand |
| --- | --- |
| Manifest-Format + `registerChannel`-Wrapper + Preload-Generator | ~1–2 Tage |
| Schemas für die ~23 heute schema-losen Payload-Kanäle nachziehen | ~2–3 Tage |
| Migration aller ~127 Kanäle in Wellen, Guard/Tests je Welle grün | ~3–4 Tage |
| **Summe** | **~6–9 Personentage** |

Risikoarm, weil der Guard jede Welle absichert und alte + neue Registrierung während
der Migration parallel bestehen können.
