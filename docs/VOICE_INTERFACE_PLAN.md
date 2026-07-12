# Voice-Steuerung für den ausgewählten Agent

Stand: 12. Juli 2026

## Ziel

Orca-Strator erhält oben im Workspace eine Voice-Leiste, die immer den aktuell
angeklickten Agent adressiert. Der erste Lieferumfang ist bewusst
**Speech-to-Text mit Push-to-talk**. Der erkannte Text wird vor dem Absenden
sichtbar bestätigt und niemals ungefragt an den Agent geschickt.

Die wichtigste Qualitätsanforderung ist sehr gutes Deutsch, einschließlich
Umlauten, zusammengesetzten Wörtern und typischen gemischten Sätzen aus Deutsch,
englischen Codebegriffen, Datei- und Branch-Namen.

## Produktverhalten

1. Ein Klick auf eine Agent-Kachel setzt `selectedAgentId`.
2. Die Voice-Leiste zeigt Name, Provider und Branch des Ziel-Agents.
3. Gedrückthalten von Mikrofon oder Shortcut startet die Aufnahme.
4. Loslassen beendet die Aufnahme und startet die Transkription.
5. Ein editierbares Vorschaufeld zeigt das Ergebnis.
6. **Einfügen** schreibt den Text in die aktive Agent-PTY; **Senden** fügt
   zusätzlich Enter an. Escape verwirft die Aufnahme.
7. Ein Agentwechsel während einer Aufnahme stoppt die Aufnahme und verlangt eine
   neue Bestätigung. Dadurch landet Sprache nie im falschen Terminal.

Ohne ausgewählten oder laufenden Agent bleibt die Voice-Leiste deaktiviert. Der
Fokusmodus und Pop-out-Fenster verwenden dieselbe zentrale Auswahl.

## STT-Entscheidung

### Empfohlener Qualitätsmodus

Für kurze, abgeschlossene Push-to-talk-Aufnahmen ist
[`gpt-4o-transcribe`](https://developers.openai.com/api/docs/models/gpt-4o-transcribe)
der Startkandidat. OpenAI beschreibt gegenüber den ursprünglichen
Whisper-Modellen eine niedrigere Wortfehlerrate sowie bessere Sprach- und
Erkennungsgenauigkeit. Für Orca werden Deutsch als Sprache und ein
workspace-spezifisches Vokabular mit Repo-, Agent-, Branch- und Technologietermen
mitgegeben.

Diese Entscheidung ist kein Blindflug: Vor Freigabe wird das Modell gegen einen
kleinen Orca-Deutschkorpus gemessen. Der Provider bleibt austauschbar, falls ein
anderer Dienst oder eine lokale Lösung bei deutschen technischen Diktaten besser
abschneidet.

### Realtime und lokal

[`gpt-realtime-whisper`](https://developers.openai.com/api/docs/models/gpt-realtime-whisper)
ist erst Phase 2, wenn laufende Zwischenresultate den Zusatzaufwand rechtfertigen.
Push-to-talk mit kompletter Äußerung priorisiert zunächst Genauigkeit und
vorhersagbares Zielrouting vor minimaler Latenz.

Ein optionaler lokaler Adapter auf Basis von `whisper.cpp`/Whisper large-v3 wird
als Offline-/Datenschutzmodus evaluiert. Er ist kein stiller Fallback: Download,
Hardwarebedarf, Modellversion und Qualitätsniveau müssen in den Einstellungen
sichtbar sein.

## Technische Architektur

```text
MediaDevices/MediaRecorder
        |
        v
VoiceBar (Renderer) -- selectedAgentId --> VoiceStore
        |                                  |
        | IPC: transcribe                  | bestätigter Text
        v                                  v
VoiceService (Main)                 agentManager.write(...)
        |
        +-- OpenAITranscriptionProvider
        +-- LocalWhisperProvider (optional)
```

Geplante Repo-Schnitte:

- `useAppStore.ts`: `selectedAgentId`, Aufnahme-/Transkriptzustand und
  explizite Zielbindung.
- `Workspace.tsx`/`AgentPane.tsx`: aktuelle lokale Fokus-ID in den Store
  heben; Auswahl visuell und per Tastatur zugänglich machen.
- `VoiceBar.tsx`: Mikrofon, Pegel, Status, Vorschau, Einfügen/Senden/Verwerfen.
- `src/shared/voice.ts`: IPC-Typen, Providerfähigkeiten und Fehlerzustände.
- `src/main/voice/VoiceService.ts`: Größen-/Zeitlimits, Transkription,
  Abbruchsignal, Vokabular und Telemetrie ohne Audioinhalt.
- API-Schlüssel nur im Main-Prozess und verschlüsselt über Electron
  `safeStorage`; kein Secret und kein Audio-Upload aus dem Renderer.

## Deutsche Qualitätsabnahme

Ein versionierter Testkorpus enthält mindestens 60 selbst aufgenommene,
einwilligungsfähige Äußerungen:

- 20 Standarddeutsch-Sätze,
- 20 gemischte Deutsch-/Code-Sätze,
- 10 Datei-, Branch- und Paketnamen,
- 10 schwierigere Fälle mit Nebengeräusch oder regionaler Färbung.

Vor dem MVP werden mindestens Cloud-Qualitätsmodus und lokaler Kandidat
blind verglichen. Zielwerte:

- höchstens 8 % WER bei Standarddeutsch,
- höchstens 12 % WER bei gemischtem Technikdeutsch,
- mindestens 95 % Trefferquote für das bereitgestellte Workspace-Vokabular,
- Median unter 1,5 Sekunden vom Aufnahmeende bis zur Vorschau,
- null Fehlroutings zum falschen Agent in automatisierten UI-Tests.

Werden diese Werte nicht erreicht, geht die Funktion nicht als „sehr gutes
Deutsch“ live; dann folgen Vokabular-, Mikrofon- und Provider-Evaluationen.

## Text-to-Speech

TTS kommt nach STT. Rohes Terminal-Scrollback ist wegen ANSI-Sequenzen,
Fortschrittsanzeigen und Toollogs keine brauchbare Vorlesequelle. Zuerst braucht
Orca ein strukturiertes „letzte Agent-Antwort“-Signal. Dann kann die Voice-Leiste
die letzte Antwort des ausgewählten Agents vorlesen.

Der TTS-Provider wird ebenfalls austauschbar. Der MVP vergleicht eine lokale
deutsche Systemstimme mit einem Cloud-Provider. UI-Anforderungen sind
Play/Pause/Stop, Sprechtempo, Stimme, sofortiger Abbruch beim Agentwechsel und
eine sichtbare Kennzeichnung synthetischer Sprache.

## Lieferphasen

### Phase 1 – sicheres Push-to-talk STT

- zentrale Agent-Auswahl,
- Mikrofonberechtigung und Aufnahme,
- Qualitäts-Transkription Deutsch,
- editierbare Vorschau,
- getrennte Aktionen Einfügen und Senden,
- Secrets via `safeStorage`,
- Unit-, IPC- und Routingtests.

### Phase 2 – Realtime-Komfort und Offline-Option

- Zwischenresultate,
- konfigurierbarer Shortcut,
- Workspace-Vokabularverwaltung,
- lokaler Whisper-Adapter mit Hardwarecheck,
- Qualitäts-/Latenzanzeige statt stiller Fallbacks.

### Phase 3 – TTS

- strukturierte letzte Agent-Antwort,
- deutsche Stimmenauswahl,
- Wiedergabesteuerung und Barrierefreiheit,
- keine automatische Wiedergabe ohne Opt-in.

## Nicht-Ziele des MVP

- dauerhaft offenes Mikrofon,
- automatische Sendung ohne Bestätigung,
- gleichzeitige Sprache an mehrere Agents,
- Aufnahme oder Speicherung von Audioverläufen,
- Vorlesen ungefilterter Terminalausgabe.
