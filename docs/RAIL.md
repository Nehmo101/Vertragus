# Desktop-Rail

Die Rail ist eine schmale, rahmenlose Always-on-top-Startleiste am
Bildschirmrand (`#/sidebar`). Sie zeigt die Workspace-Profile als Kacheln;
ein Klick startet das Profil und kachelt jeden Agenten — inklusive des
Orchestrators — als eigenes Terminal-Fenster über die freie Arbeitsfläche.

## Startmodus

`ui.startMode` (`full` | `rail`) bestimmt, welches Fenster beim App-Start
erscheint. Umschalten im Titelleisten-Überlaufmenü („⋯" → *Startmodus
wechseln*); wirkt ab dem nächsten Start. `UI_SMOKE`/`SCREENSHOT`/E2E booten
immer das Vollfenster. Rettungsanker: Das Tray-Menü bietet immer
„Vertragus öffnen" (Vollfenster) und „Rail umschalten".

## Verhalten

- **Drag & Snap**: Die gesamte freie Fläche ist Drag-Griff (natives
  `-webkit-app-region: drag`, Voice-Overlay-Muster); Buttons, Kacheln und
  die Profil-Liste sind no-drag. Nach dem Drag snappt der Main-Prozess im
  `moved`-Event bei < 24 px an die linke/rechte Kante und persistiert die
  Lage (`ui.railBounds`: Kante + y) für den nächsten Start.
- **Schließen**: ✕ im Header schließt die Rail; ist sie das letzte
  Fenster, beendet das Vertragus (window-all-closed).
- **Start-Feedback**: Während `rail:launchTiled` läuft, zeigt die Kachel
  einen Spinner (Doppelklick-Schutz). Scheitert der Start, erscheint die
  Fehlermeldung als Banner in der Rail (mit Dismiss) — nie stilles
  Scheitern. Nach einem Fehlstart leuchtet kein Aktiv-Rahmen: der Glow
  ist an tatsächlich laufende Agenten gebunden, nicht an die Session.
- **Stoppen**: Neben aktiven Kacheln sitzt ein ■-Knopf — zweistufig
  (erster Klick armiert für 3 s, zweiter beendet alle Agenten des
  Profils via `agents.clean`).

## Verifikation

- `pnpm run build && pnpm run test:rail-smoke` — Boot-Screenshot (dark/light).
- `pnpm run build && pnpm run test:rail-e2e` — klickt die echte App durch:
  Hydration, Drag-Regionen, Kanten-Snap, Yolo-Toggle, Live-Badges,
  Vollansicht, Fehlstart-Banner, Schließen; Screenshots in
  `e2e-artifacts/rail/`.
- **Live-State**: Die Rail spiegelt den Store über die normalen
  `ev:`-Broadcasts (`ev:agentsChanged`, `ev:workspaceSessions`,
  `ev:configChanged`, neu `ev:profilesChanged`). Sie schreibt geteilten
  State ausschließlich über IPC-Actions (Mirror-only-Regel).
- **Tiled Launch** (`rail:launchTiled`): startet `spawnProfileTeam` und
  verteilt die Panes über `computeTiles` (src/main/tiling.ts) — WorkArea
  minus Rail-Streifen, Raster ≈ `sqrt(n·Seitenverhältnis)`, Mindestgröße
  420×300, Orchestrator in der ersten Zelle (einreihig mit freier Zelle:
  doppelt breit), Überzählige kaskadieren. Ein erneuter Klick bei laufender
  Session fokussiert + kachelt neu statt zu respawnen.

## Vertrauensmodell

Die Rail ist NICHT das Hauptfenster. Sie teilt das Renderer-Preload, ihre
Steuerkanäle sind aber begrenzt (`src/shared/ipcManifest.ts`):

| Kanal | auth | Zweck |
|---|---|---|
| `rail:toggle` | main-window | Rail ein-/ausblenden (Überlaufmenü) |
| `rail:openMain` | custom (`guardRailControl`: Rail ODER Hauptfenster) | Vollansicht öffnen/fokussieren |
| `rail:launchTiled` | custom (`guardRailControl`) | Profil starten + kacheln |

Das Verschieben braucht keinen IPC-Kanal mehr — es läuft nativ über
`-webkit-app-region: drag`; Snap + Persistenz übernimmt der Main-Prozess.

Das Voice-Overlay kann keinen dieser Kanäle aufrufen. Profile starten kann
die Rail wie jedes Nicht-Voice-Fenster (`agents:spawnProfile` ist
`not-voice`); privilegierte Remote-/Voice-Einstellungen bleiben dem
Hauptfenster vorbehalten. `ui.railBounds` ist bewusst NICHT über die
Config-IPC erreichbar — nur der Main-Prozess schreibt es.
