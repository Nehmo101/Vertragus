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

- **Drag & Snap**: Der Orb oben ist der Drag-Griff. Die Rail schnappt bei
  < 24 px an die linke/rechte Kante; Position (`ui.railBounds`: Kante + y)
  wird debounced persistiert und beim nächsten Start wiederhergestellt.
- **Hover-Expand**: kompakt 64 px (Orb + Initialen), expandiert per
  Hover/Focus auf volle Breite — rein per CSS im transparenten Fenster,
  kein Resize-IPC.
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
| `rail:moved` | custom (nur Rail; andere Sender werden verworfen) | Drag-Position |
| `rail:launchTiled` | custom (`guardRailControl`) | Profil starten + kacheln |

Das Voice-Overlay kann keinen dieser Kanäle aufrufen. Profile starten kann
die Rail wie jedes Nicht-Voice-Fenster (`agents:spawnProfile` ist
`not-voice`); privilegierte Remote-/Voice-Einstellungen bleiben dem
Hauptfenster vorbehalten. `ui.railBounds` ist bewusst NICHT über die
Config-IPC erreichbar — nur der Main-Prozess schreibt es.
