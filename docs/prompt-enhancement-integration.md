# Prompt schärfen: produktive Integration

„Prompt schärfen“ verbessert den aktuellen lokalen Inbox-Draft, ohne ihn vorher zu speichern und
ohne eine Profilübergabe, Planung oder Agent-Ausführung zu starten. Die bestehende
`previewIdeaTransferBriefing`- und Übergabelogik bleibt davon getrennt und unverändert.

## Sicherheits- und Prozessgrenzen

- `src/shared/promptEnhancement.ts` definiert strikt validierte Zod-Schemas für Draft, Request,
  Abort und Response. Renderer-Payloads können keine Dateipfade, Transferdaten oder
  Workspace-Fakten transportieren.
- `src/main/inbox/promptEnhancementIpc.ts` autorisiert ausschließlich bekannte Orca-Hauptframes
  mit vertrauenswürdiger Renderer-URL. Request-IDs sind an den jeweiligen Sender gebunden;
  fremde Fenster können einen Request nicht abbrechen.
- Eine im Draft referenzierte Profil-ID wird im Main-Konfigurationsstore aufgelöst. Ein vorhandener
  Profil-Orchestrator hat Vorrang. Ohne Profil oder Orchestrator gibt es keine stille
  Cloud-Auswahl; die UI verlangt eine ausdrückliche Wahl.
- `src/main/inbox/promptEnhancementContext.ts` inspiziert read-only eine kleine feste Dateiliste.
  Root-Escape, Traversal, Geräte-/Netzwerkpfade und aus dem Root führende Symlinks werden
  abgewiesen oder ignoriert. Vollständige lokale Pfade gelangen nicht in den Prompt.
- `src/main/inbox/promptEnhancementProvider.ts` nutzt vorhandene Provider-CLI-Sessions,
  Modellauflösung und Kapazitätsgates. Der Provider läuft ohne Yolo und ohne externe MCP-Argumente
  in einem leeren temporären Verzeichnis. Es gibt keine zweite API-Key-Verwaltung.

Artefakte, Tags, Referenzen und eingegebener Text werden als `UNTRUSTED_SOURCE_DATA` markiert.
Nur tatsächlich inspizierte Fakten tragen `evidence: "workspace-inspection"`. Eingabe-, Timeout-,
Abort- und Ausgabelimits sowie strikte Modellantwort-Schemas begrenzen die Ausführung. Secrets und
Fragmente interner Prompt-Regeln werden vor Ausgabe entfernt beziehungsweise abgewiesen.

## Renderer-Verhalten

Die vorhandene Schaltfläche zeigt während der Ausführung „Wird geschärft …“. Original und
Vorschlag bleiben getrennt sichtbar. Provider und effektives Modell werden transparent angezeigt.
Abbruch, Fehler und stale Antworten verändern den Draft nicht. „Übernehmen“ verlangt eine zweite
Bestätigung und ersetzt danach ausschließlich den lokalen Titel und Inhalt; Status, Tags,
Artefakte, Referenzen und Transferzustand bleiben unverändert.

Ohne verfügbaren Provider kann der Benutzer den bestehenden deterministischen
`previewIdeaTransferBriefing`-Pfad ausdrücklich anfordern. Dieser wird sichtbar als
„Deterministischer Fallback – keine KI-Verbesserung“ gekennzeichnet und nie als KI-Ergebnis
ausgegeben.
