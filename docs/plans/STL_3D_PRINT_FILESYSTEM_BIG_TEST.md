# Big Test: „Facet" — Extrem ausgefeiltes STL- & 3D-Druck-Dateisystem

> **Was das hier ist.** Ein vollständiges **Ziel-Prompt für den Vertragus-Orchestrator**.
> Es dient als *großer Belastungstest*: breite Fächerung in parallele Module,
> ein sauberer geschichteter DAG, genau **ein** Integrator, advisory Reviews,
> harte Quality Gates. Am Ende steht ein fertiges, „perfektes" Produkt:
> Desktop-Start-Icon mit Logo → schön gestaltete Website → Dateipfad hinterlegen
> → Analyse läuft los.
>
> **So benutzt du es.** In Vertragus ein leeres/neues Projektverzeichnis als
> Working Directory wählen, ein orchestriertes Profil starten (Claude-Orchestrator
> + 4–6 Subagent-Slots, Planer `auto` oder `review`), und den Block
> **[»Ziel zum Einfügen«](#ziel-zum-einfügen)** als Workspace-Ziel geben. Dieses
> Dokument ist die Referenz-Spezifikation, auf die sich die Subagents beziehen.
> Der Produktname **Facet** ist ein Vorschlag und frei umbenennbar.

---

## Inhalt

- [Ziel zum Einfügen](#ziel-zum-einfügen)
- [Produktvision](#produktvision)
- [Tech-Stack & Architektur](#tech-stack--architektur)
- [Datenmodell & API-Vertrag](#datenmodell--api-vertrag)
- [Feature-Katalog (Module M1–M10)](#feature-katalog-module-m1m10)
- [Sortier-, Filter- & Gruppier-Matrix](#sortier--filter--gruppier-matrix)
- [Empfohlene Ordnerstruktur (Verbesserungsvorschläge)](#empfohlene-ordnerstruktur-verbesserungsvorschläge)
- [Definition of Done / Abnahmekriterien](#definition-of-done--abnahmekriterien)
- [Orchestrierungs-Hinweise (empfohlener DAG)](#orchestrierungs-hinweise-empfohlener-dag)
- [Logo- & Icon-Brief](#logo--icon-brief)

---

## Ziel zum Einfügen

> Kopiere den folgenden Block als **Workspace-Ziel** in Vertragus. Die restlichen
> Abschnitte dieses Dokuments sind die verbindliche Detail-Spezifikation.

```text
Baue ein produktionsreifes, lokal laufendes STL-/3D-Druck-Dateisystem namens
"Facet": eine wunderschön gestaltete Web-App plus Desktop-Start-Icon (Windows +
Linux), die einen vom Nutzer hinterlegten Ordnerpfad scannt, jede 3D-Datei
analysiert (Geometrie, Druckbarkeit, Kosten/Zeit-Schätzung), in einem
beweglichen (Orbit/Zoom/Pan) 3D-Viewer darstellt, eine durchsuch-, sortier- und
filterbare Bibliothek bietet, Modelle per Knopfdruck an OrcaSlicer ODER Bambu
Studio übergibt und konkrete, nicht-destruktive Verbesserungsvorschläge für die
Ordnerstruktur macht (Vorschau + Übernehmen + Undo).

Ablauf für den Nutzer: Desktop-Icon anklicken -> lokaler Dienst startet ->
Standardbrowser öffnet die Facet-Website -> Ordnerpfad eingeben -> Scan &
Analyse starten automatisch -> Bibliothek erscheint.

Halte dich an die Detail-Spezifikation in
docs/plans/STL_3D_PRINT_FILESYSTEM_BIG_TEST.md (Module M1-M10, Datenmodell,
Sortier-/Filter-Matrix, empfohlene Ordnerstruktur, Definition of Done).

Architektur: TypeScript durchgängig. Node-Backend (lokaler HTTP+WS-Dienst,
Dateisystem-Scan, Mesh-Parser & Analyse, SQLite-Index via better-sqlite3,
Slicer-Start). React+Vite-Frontend mit three.js-Viewer. Optionaler Electron/Tray-
Shell fuer natives Fenster + Autostart des Browsers. Alles offline/local-first,
keine Cloud, keine Telemetrie.

Definition of Done: pnpm-Workspace mit gruenem Gate (lint + typecheck + test +
build); Desktop-Icon startet die App; Pfad-Eingabe loest Scan+Analyse aus; der
3D-Viewer ist per Maus/Touch/Tastatur frei drehbar (Orbit/Zoom/Pan) mit
mindestens Shaded-, Wireframe- und Overhang-Heatmap-Modus; alle in der Matrix
gelisteten Sortier- und Filterschluessel funktionieren; "An OrcaSlicer senden"
und "An Bambu Studio senden" starten den installierten Slicer mit der Datei (mit
sauberem Fallback, wenn nicht installiert); der Ordnerstruktur-Assistent zeigt
eine Vorschau und wendet sie non-destruktiv mit Undo an; Tags/Notizen/
Druckhistorie ueberleben Neustarts; Dark/Light, responsiv, barrierefrei, DE/EN;
Tests decken Parser-Mathematik, Sortierer, Dedupe, einen Scan-Integrationslauf
und einen E2E-Pfad ab; README + Nutzerhandbuch + Ordnerstruktur-Doc liegen bei.

Arbeite geschichtet: erst ein Design-/Vertrags-Task (Typen, API, SQLite-Schema,
Design-Tokens), dann parallele Feature-Module, advisory Reviews (Security,
A11y/Design, Performance), und GENAU EIN Integrator, der die App-Shell verdrahtet,
alle Gates gruen faehrt und das Desktop-Icon erzeugt. Liefere am Ende eine
Zusammenfassung mit Risiken und eine Kurzanleitung zum Starten.
```

---

## Produktvision

**Facet** verwandelt einen chaotischen „STL-Grab"-Ordner in eine kuratierte,
durchsuchbare Bibliothek — mit der Tiefe eines CAD-Analysetools und der
Leichtigkeit einer Foto-App. Kernversprechen:

1. **Sehen** — jedes Modell in einem flüssigen, frei beweglichen 3D-Viewer.
2. **Verstehen** — automatische Analyse: Ist es druckbar? Wasserdicht? Passt es
   auf meinen Drucker? Wie viel Filament, Zeit, Geld?
3. **Finden** — sortieren, filtern, gruppieren, volltextsuchen über tausende
   Dateien in Millisekunden.
4. **Handeln** — ein Klick an OrcaSlicer oder Bambu Studio.
5. **Aufräumen** — Facet erkennt Duplikate, lose Dateien und Namens-Chaos und
   schlägt eine saubere Ordnerstruktur vor (Vorschau statt Zwang).

Local-first, offline, ohne Konto, ohne Cloud. Der Ordner des Nutzers bleibt die
Quelle der Wahrheit; Facet legt nur einen Sidecar-Index (SQLite) und einen
Thumbnail-Cache an und fasst Originaldateien nur an, wenn der Nutzer eine
Reorganisation ausdrücklich bestätigt.

---

## Tech-Stack & Architektur

| Schicht | Technologie | Aufgabe |
|---|---|---|
| **Backend-Dienst** | Node 22 + TypeScript, Fastify (o. ä.), `ws` | Lokaler HTTP+WebSocket-Server auf `127.0.0.1:<port>`; Scan, Analyse-Jobs, Slicer-Start, Reorg |
| **Mesh-Engine** | TypeScript (eigene Parser + Analyse), Worker-Threads | STL/3MF/OBJ parsen, Geometrie- & Druckbarkeits-Metriken |
| **Index/DB** | `better-sqlite3` | Datei-Index, Metadaten, Tags, Collections, Druckhistorie, Cache-Keys |
| **Frontend** | React 18 + Vite + TypeScript, `three` + `OrbitControls`, Zustand | Website/SPA: Bibliothek, Viewer, Detail, Dashboard, Onboarding |
| **Desktop-Shell** | Electron *oder* Tray-Launcher (Node) + `.desktop`/`.lnk` + Icons | Start-Icon → Dienst hochfahren → Browser/Fenster öffnen; Single-Instance; Tray-Quit |
| **Optionaler Sidecar** | Python + `trimesh` (nur falls STEP/Repair nötig) | Schwere Reparatur/STEP-Import; klar als optional gekapselt |

**Grundsätze**

- **Local-first & privat:** kein Netzwerkzugriff außer localhost; keine Telemetrie.
- **Nicht-blockierend:** Parsing/Analyse/Thumbnails laufen in Worker-Threads;
  Fortschritt streamt per WebSocket ins UI.
- **Inkrementell:** Dateien werden über `path + mtime + size + contentHash`
  gecacht; unveränderte Dateien werden nicht neu geparst.
- **Cross-Platform-Pfade:** robustes Handling für Windows- und Linux-Pfade,
  Umlaute, lange Pfade, Netzlaufwerke.
- **Sicher:** Pfad-Whitelist (nur der gewählte Root + Unterordner), kein
  Path-Traversal, Slicer-Start ohne Shell-Injection (`spawn` mit Argv-Array).

---

## Datenmodell & API-Vertrag

**Der Design-/Vertrags-Task (Layer 0) legt diese Contracts fest, bevor Module bauen.**

### Kern-Entitäten (SQLite)

```
model(
  id, path, filename, format, sizeBytes, mtime, contentHash,
  addedAt, updatedAt,
  triCount, vertCount, shellCount,
  bboxX, bboxY, bboxZ,           -- mm
  volumeMm3, surfaceAreaMm2, centerOfMassXYZ,
  isWatertight, boundaryEdges, nonManifoldEdges, degenerateTris, flippedNormals,
  overhangAreaPct,               -- Fläche > Schwellwinkel
  thumbnailPath, printabilityScore, rating, isFavorite,
  sourceUrl, designer, license, notes
)
tag(id, name, color)            model_tag(modelId, tagId)
collection(id, name, kind)      collection_model(collectionId, modelId, sortIndex)
print_log(id, modelId, printedAt, printer, material, resultOk, photoPath, settingsJson, notes)
scan_root(id, path, addedAt, lastScanAt)
```

### HTTP/WS-API (Auszug)

| Methode | Route | Zweck |
|---|---|---|
| `POST` | `/api/roots` | Ordnerpfad hinterlegen & Scan starten |
| `GET`  | `/api/scan/stream` (WS) | Live-Fortschritt: gefunden/analysiert/thumbnailed |
| `GET`  | `/api/models` | Liste mit `sort`, `order`, `filter`, `group`, `q`, `page` |
| `GET`  | `/api/models/:id` | Detail inkl. Analyse & Historie |
| `GET`  | `/api/models/:id/mesh` | dezimierte Geometrie fürs Viewer-Streaming |
| `POST` | `/api/models/:id/open-in/:slicer` | `orca` \| `bambu` starten |
| `POST` | `/api/models/:id/tags` · `/rating` · `/notes` · `/print-log` | Metadaten |
| `POST` | `/api/reorg/plan` · `/api/reorg/apply` · `/api/reorg/undo` | Ordnerstruktur-Assistent |
| `GET`  | `/api/stats` | Dashboard-Kennzahlen |

---

## Feature-Katalog (Module M1–M10)

> Jedes Modul ist so geschnitten, dass es weitgehend **parallel** von einem
> eigenen Subagent gebaut werden kann. Geteilte Dateien (Typen, API-Router,
> App-Shell, globale Styles) gehören dem **Integrator**, nicht den Feature-Tasks.

### M1 — Scanner, Watcher & Index
- Rekursiver Scan des Root-Pfads; Formate: `.stl .3mf .obj .amf .ply .step/.stp
  .gcode .bgcode` (STEP/Repair optional via Sidecar).
- **Inkrementell** über `mtime+size+hash`; nur Neues/Geändertes analysieren.
- Datei-Watcher (`chokidar`): neue/gelöschte/umbenannte Dateien live nachziehen.
- Job-Queue mit Priorität (sichtbare Kacheln zuerst), Backpressure, Abbruch.
- Robuste Fehlerbehandlung: korrupte/leere/riesige Dateien überspringen &
  markieren, niemals crashen.

### M2 — Mesh-Parser & Analyse-Engine
- **Parser:** Binär- & ASCII-STL, 3MF (ZIP+XML, mehrere Objekte + Trans+ eingebettete Thumbnails), OBJ, AMF, PLY.
- **Geometrie:** Dreiecks-/Vertexzahl, Bounding-Box (X/Y/Z mm), **Volumen**
  (Summe vorzeichenbehafteter Tetraeder), Oberfläche, Schwerpunkt,
  Zusammenhangskomponenten (Shells).
- **Wasserdicht/Manifold:** Half-Edge-Aufbau; jede Kante genau von 2 Dreiecken
  mit konsistenter Windung geteilt. Erkenne **Randkanten (Löcher)**,
  **Non-Manifold-Kanten (>2)**, **degenerierte** (Nullfläche) & **doppelte**
  Dreiecke, **invertierte Normalen**.
- **Druckbarkeit:**
  - *Passt auf den Drucker?* Vergleich BBox ↔ Druckerprofil (s. u.), inkl.
    „passt gedreht".
  - *Overhang/Support:* pro Dreieck Winkel der Normalen zur Baurichtung;
    Flächenanteil unter Schwellwinkel (Default 45°) → Support nötig; als Prozent.
  - *Dünnwand-/Mindestfeature-Heuristik* (unter Düsendurchmesser).
  - *Empfohlene Orientierung* (min. Supports / min. Höhe / max. Festigkeit).
- **Verbrauchs-/Kosten-/Zeit-Schätzung** (heuristisch, klar als Schätzung markiert;
  „für exakte Werte slicen"):
  - Filamentlänge `L = Volumeneffektiv / A`, mit `A(1.75mm) ≈ 2.405 mm²`.
  - Masse `m[g] = V[cm³] × ρ`; Kosten `= m × €/kg`.
  - Zeit-Heuristik aus Volumen/Schichthöhe/Speed.
- **Druckerprofile (konfigurierbar, Startwerte):** Bambu A1 mini 180³, A1 256³,
  P1P/P1S/X1C 256³; Prusa MK4 250×210×220, XL 360³; Ender 3 220×220×250;
  Voron 250/300/350³.
- **Materialdichten ρ (g/cm³):** PLA 1.24 · PETG 1.27 · ABS 1.04 · ASA 1.07 ·
  TPU 1.21 · PA 1.14 · PC 1.20 (erweiterbar).
- **Printability-Score** (0–100) aus Wasserdichtheit, Passform, Overhang-Anteil,
  Fehlern — treibt Sortierung/Filter/Badges.
- Alle Analysen als reine, **unit-getestete** Funktionen (Fixtures: Würfel,
  Kugel, offenes Mesh, Non-Manifold, riesiges Mesh).

### M3 — 3D-Viewer (beweglich!)
> Ausdrücklicher Nutzerwunsch: die 3D-Ansichten müssen **beweglich** sein.
- `three.js` + **OrbitControls**: **Drehen/Orbit, Zoom, Pan** per Maus, Touch
  (Pinch/Drag) und Tastatur; Trägheit/Damping; Reset & Preset-Ansichten
  (Top/Front/Side/Iso); Auto-Fit.
- **Referenz:** Bauplatte + Raster + Achsen in echten mm; Modellmaße eingeblendet.
- **Render-Modi:** Shaded, **Wireframe**, Röntgen/Transparent, Normalen,
  **Overhang-Heatmap** (Flächen nach Overhang-Winkel eingefärbt),
  **Wandstärken-Heatmap**.
- **Werkzeuge:** Schnittebene/Clipping (Slider), Messwerkzeug (Punkt-zu-Punkt &
  BBox), Support-Bereiche einblenden, Screenshot/Thumbnail-Capture, Vollbild.
- **Performance:** `BufferGeometry`, Parsing/Dezimierung im Worker, LOD/Preview
  für riesige Meshes; `prefers-reduced-motion` respektieren; komplett per Tastatur
  bedienbar.

### M4 — Bibliothek-UI (Sortieren/Filtern/Gruppieren/Suchen)
- **Ansichten:** Kachel/Grid (Thumbnails, virtuelles Scrolling für tausende
  Objekte), Liste/Tabelle (sortierbare Spalten), Detail-Panel.
- **Sortieren, Filtern, Gruppieren, Suchen** exakt nach der
  [Matrix](#sortier--filter--gruppier-matrix).
- **Smart-Collections** (gespeicherte Filter, z. B. „Nicht wasserdicht",
  „Passt nicht auf A1", „Diese Woche hinzugefügt").
- **Mehrfachauswahl + Bulk-Aktionen:** taggen, verschieben, an Slicer senden,
  exportieren, löschen (mit Bestätigung/Undo).
- Tastenkürzel, Drag & Drop, Leerzustände, Lade-Skelette.

### M5 — Detailansicht, Metadaten & Druckhistorie
- Großer Viewer + vollständige Analyse-Metriken + Fehler-Badges mit Erklärung.
- **Metadaten-Editor:** Quelle/URL (Printables/MakerWorld/Thingiverse), Designer,
  Lizenz, Notizen, Tags, Bewertung, Favorit.
- **Druck-Log:** Datum, Drucker, Material, Erfolg/Fehlschlag, Foto, Einstellungen,
  Notiz — mit Timeline und Erfolgsquote pro Modell.
- **Versionen/Varianten** desselben Modells verknüpfen (v1/v2, „_fixed", Skalierung).

### M6 — Slicer-Integration (OrcaSlicer / Bambu Studio)
- Installierte Slicer erkennen (typische Pfade je OS; PATH; Registry unter Windows).
- **„An OrcaSlicer senden"** / **„An Bambu Studio senden":** `spawn` mit
  Dateipfad als Argv (kein Shell-String); optional erst ein sauberes **3MF mit
  Platte + Objekt** erzeugen.
- Fallback, wenn nicht installiert: klare Meldung + Download-Link + „Pfad manuell
  setzen".
- Optional: Standard-Slicer pro Nutzer wählbar; Bulk-Senden.

### M7 — Ordnerstruktur-Assistent (Verbesserungsvorschläge)
- **Analyse:** lose Dateien im Root, uneinheitliche Namen, gemischte Formate,
  **Duplikate** (gleicher `contentHash` und/oder gleiche Geometrie), verwaiste
  Support-/Slicer-Dateien, tiefe/verschachtelte Chaos-Ordner.
- **Vorschlag:** kanonische Struktur (s.
  [unten](#empfohlene-ordnerstruktur-verbesserungsvorschläge)) + Namensschema
  `Designer_Modell_Version_Variante.stl`.
- **Nicht-destruktiv:** erst **Plan/Diff-Vorschau**, dann **Übernehmen** (Move mit
  Kollisionsschutz) mit vollständigem **Undo**; Dry-Run-Default.
- Auto-Tagging aus Ordnernamen/Quelle; Dubletten „verlinken statt löschen"
  anbieten.

### M8 — Desktop-Launcher, Icon & Onboarding
- **Start-Icon auf dem Desktop** mit dem Facet-Logo (Windows `.lnk`+`.ico`,
  Linux `.desktop`+PNG; macOS optional). Icons aus `docs/assets/facet-logo.svg`
  generiert (Sharp-Pipeline analog Vertragus `scripts/gen-icons.mjs`).
- Klick → **Single-Instance-Dienst** startet → **Standardbrowser** öffnet
  `http://127.0.0.1:<port>` (oder natives Electron-Fenster). **Tray-Icon** mit
  „Öffnen"/„Beenden". Freie Portwahl, sauberes Herunterfahren.
- **Onboarding (der Kern-Flow des Nutzers):** beim ersten Start **Dateipfad
  hinterlegen** (Eingabe + nativer Ordner-Dialog), validieren → **Scan & Analyse
  starten automatisch** mit Live-Fortschritt → Bibliothek erscheint. Pfad(e)
  werden persistiert; mehrere Roots möglich.

### M9 — Design-System & Website-Shell & Dashboard
- **Wunderschön gestaltet:** konsistentes Design-System (Typo-Skala, Spacing,
  Farb-Tokens, Radius, Schatten, Motion), **Dark/Light** mit Persistenz,
  Mikrointeraktionen, sauberer Leer-/Fehler-/Ladezustand, responsiv.
- **Dashboard:** Kennzahlen (Modelle gesamt, druckbar %, Gesamtvolumen,
  Speicher, Top-Tags), zuletzt hinzugefügt, „braucht Aufmerksamkeit"
  (nicht wasserdicht / Duplikate / unsortiert), Schnellaktionen.
- Eigene, vom Vertragus-Branding **abgegrenzte** Facet-Identität (Palette:
  Photon-Teal ↔ Filament-Amber, s. Logo-Brief).

### M10 — Nicht-funktional (Performance, Sicherheit, i18n, Tests)
- **Performance:** tausende Dateien flüssig; virtuelles Grid; Thumbnail-Cache;
  inkrementeller Scan; Worker-Pool; Ziel: Erst-Scan von 1.000 Dateien mit
  sichtbarem Fortschritt, UI bleibt reaktiv.
- **Sicherheit:** localhost-only, Pfad-Whitelist, kein Traversal, `spawn`-Argv,
  keine Remote-Requests; CSP im Renderer.
- **i18n:** DE/EN (i18next), Einheiten (mm/inch, g, €/`$`).
- **Barrierefreiheit:** Tastaturbedienung, Fokusreihenfolge, Kontrast,
  `reduced-motion`, ARIA.
- **Tests:** Unit (Parser-Mathematik, Sortierer, Dedupe, Kosten/Overhang),
  Integration (Scan eines Fixture-Ordners → erwarteter Index), **E2E** (App
  öffnen → Pfad eingeben → Grid → Viewer drehen → „An Slicer senden" gemockt).

---

## Sortier-, Filter- & Gruppier-Matrix

**Sortieren nach:** Name · Datum hinzugefügt · Datum geändert · Dateigröße ·
Volumen · größte Kantenlänge (BBox) · Höhe/Breite/Tiefe · Dreieckszahl ·
geschätzte Druckzeit · geschätzte Kosten · Bewertung · Anzahl Drucke ·
Printability-Score · Format · zuletzt gedruckt. (Auf-/absteigend, sekundärer
Sortierschlüssel.)

**Filtern nach:** Format · Tag(s) · Collection · wasserdicht ja/nein ·
Fehler vorhanden · braucht Supports · passt auf Drucker *X* (Profil wählbar) ·
Größenbereich/Maßbereich · Bewertung ≥ *n* · Favorit · Lizenz · Quelle ·
bereits gedruckt/nie gedruckt · Duplikat.

**Gruppieren nach:** Projekt/Ordner · Tag · Format · Drucker-Kompatibilität ·
Quelle/Designer · Hinzufüge-Zeitraum.

**Suchen:** Fuzzy über Dateiname + Tags + Notizen + Designer; Live, unter 50 ms
bei tausenden Einträgen (SQLite-Index/FTS).

---

## Empfohlene Ordnerstruktur (Verbesserungsvorschläge)

Facet schlägt diese kanonische Struktur vor und kann bestehende Sammlungen
non-destruktiv dorthin migrieren (Vorschau → Übernehmen → Undo):

```
3D-Models/
├── _Inbox/                 # Neu/unsortiert (Landezone für Downloads)
├── Projects/
│   └── <Projekt>/
│       ├── source/         # CAD/STEP/native Formate
│       ├── stl/            # druckfertige Meshes
│       ├── gcode/          # geslicte Dateien
│       ├── images/         # Renders/Fotos
│       └── docs/           # Lizenz, Notizen, README, Quelle-URL
├── Library/                # wiederverwendbare Einzelteile, kategorisiert
│   ├── Functional/
│   ├── Miniatures/
│   ├── Household/
│   └── Spare-Parts/
└── Archive/                # fertig/abgelegt
```

**Namensschema:** `Designer_Modell_Version_Variante.stl`
(z. B. `Prusa_Benchy_v2_0.2mm.stl`). **Regeln:** keine losen Dateien im Root,
konsistente Formattrennung, Duplikate verlinken statt kopieren, Lizenz/Quelle je
Projekt in `docs/` festhalten. Alle Regeln sind Vorschläge — der Nutzer bestätigt
jede Änderung.

---

## Definition of Done / Abnahmekriterien

Das Ziel gilt als **verifiziert erreicht**, wenn *alle* Punkte belegt sind:

- [ ] **Gate grün:** pnpm-Workspace mit `lint + typecheck + test + build` grün
      (ein einzelnes `ci`-Skript, das alles bündelt).
- [ ] **Start-Flow:** Desktop-Icon startet Dienst → Browser/Fenster öffnet →
      **Pfad eingeben löst Scan + Analyse automatisch aus** → Bibliothek erscheint.
- [ ] **Beweglicher Viewer:** frei per Maus/Touch/Tastatur drehbar
      (Orbit/Zoom/Pan), mind. Shaded + Wireframe + Overhang-Heatmap, Preset-Views.
- [ ] **Analyse korrekt:** Volumen/BBox/Wasserdichtheit/Overhang auf den
      Fixtures unit-getestet; Kosten/Zeit als Schätzung ausgewiesen.
- [ ] **Sortieren/Filtern/Suchen:** jeder Schlüssel der Matrix funktioniert,
      inkl. Gruppierung und mind. einer Smart-Collection.
- [ ] **Slicer:** „An OrcaSlicer senden" **und** „An Bambu Studio senden" starten
      den installierten Slicer mit der Datei; sauberer Fallback ohne Installation.
- [ ] **Ordnerstruktur-Assistent:** erzeugt Vorschau, wendet non-destruktiv an,
      **Undo** funktioniert; Duplikaterkennung greift.
- [ ] **Persistenz:** Tags/Notizen/Bewertungen/Druckhistorie überleben Neustarts.
- [ ] **Qualität:** Dark/Light, responsiv, barrierefrei, DE/EN.
- [ ] **Tests:** Parser-Mathematik, Sortierer, Dedupe, ein Scan-Integrationslauf,
      ein E2E-Pfad — alle grün.
- [ ] **Docs:** README (Start in 3 Schritten) + Nutzerhandbuch + dieses
      Ordnerstruktur-Doc liegen bei; Logo/Icons generiert.

---

## Orchestrierungs-Hinweise (empfohlener DAG)

> Diese Hinweise machen die Aufgabe zu einem echten **Big Test** der
> Vertragus-Planung: breite Fächerung, ein Trichter, saubere Ownership. Der
> Orchestrator soll **right-sizen**, aber diese Form ist die Referenz.

**Layer 0 — Design/Vertrag (1 Task, `required`).** Definiert geteilte Typen,
API-Routen-Vertrag, SQLite-Schema und Design-Tokens. Besitzt die späteren
Shared-Hotspots konzeptionell. Alle Module hängen an diesem Task.

**Layer 1 — Parallele Feature-Module (`maxParallel` hoch, je eigener `conflictKey`).**
M1 Scanner/Watcher · M2 Mesh-Engine · M3 Viewer · M4 Bibliothek-UI ·
M5 Detail/Metadaten · M6 Slicer · M7 Reorg-Assistent · M8 Launcher/Onboarding ·
M9 Design-System/Dashboard. Jeder Task baut gegen den Vertrag aus Layer 0 und
meldet Schnittstellen ans **Findings-Board** — **kein** Feature-Task fasst
geteilte Dateien direkt an.

**Layer 2 — Advisory Reviews (parallel, `advisory`).** Security (Pfad-Traversal,
`spawn`, CSP) · A11y/Design-Konsistenz · Performance (großer Scan, Viewer-FPS).
Werden vom Integrator konsumiert, laufen **nicht** danach.

**Layer 3 — GENAU EIN Integrator (`required`, hängt an ALLEN vorherigen Tasks).**
Verdrahtet App-Shell, API-Router, geteilten State und globale Styles; erzeugt
Desktop-Icon/Installer; fährt **alle Quality Gates grün**; schreibt README/
Handbuch; verifiziert den End-to-End-Flow. **Kein** Task läuft nach dem Integrator.

**Fallen bewusst vermeiden** (vgl. `docs/ORCHESTRATOR_TRAINING_PROMPTS.md`):
kein zweiter Integrator; Feature-Tasks deklarieren geteilte Dateien **nicht** in
`expectedFiles`; Reviews sind `advisory`, nicht `required`; DAG azyklisch und
≤ 24 Tasks. Bei Fehlschlag: fokussierter Re-Plan gegen die belegte Ursache statt
Blind-Retry.

---

## Logo- & Icon-Brief

**Vorschlag & Startdatei:** `docs/assets/facet-logo.svg` (liegt bei). Konzept:
ein **facettierter Kristall/Oktaeder** — die linke Hälfte kühl (**Photon-Teal**,
steht für Analyse), die rechte warm (**Filament-Amber**, steht für Druck) —
auf einer angedeuteten **Bauplatte mit Schichtlinien**. Facetten = STL-Dreiecke;
das Motiv „erklärt" das Produkt in einem Zeichen.

- **Palette:** Teal `#3ED0BE`/`#209386`, Amber `#F6B56A`/`#E88B39`,
  Grounds Slate/Teal-Dunkel `#1B2A31`→`#0D181C`. Bewusst **abgegrenzt** vom
  Vertragus-Bronze/Verdigris — Facet ist ein eigenes Produkt.
- **Wortmarke:** „Facet", geometrische Grotesk; optionaler Claim
  „STL & Print Library".
- **Icon-Pipeline:** aus dem SVG ICO/ICNS/PNGs/Favicon generieren
  (Sharp, analog `scripts/gen-icons.mjs`). Für Windows-Kachel & macOS-Squircle
  Feinschliff wie im Vertragus-BRAND-Doc vorgesehen.
- **Feinschliff vor Release:** Kurven glätten, Facettenkanten sauber verrunden,
  optische Zentrierung auf der Kachel.
