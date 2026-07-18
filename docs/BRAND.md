# Vertragus — Marke & Design

**Vertragus** (ver·TRA·gus) ist der antike gallisch-lateinische Name des
Windhunds (überliefert bei Arrian, 2. Jh.) — und die etymologische Wurzel von
Dantes *veltro*, dem prophezeiten Windhund aus Inferno I. Daraus leitet sich
die gesamte Namenswelt ab: **Agenten** tragen Figuren-Namen aus der Divina
Commedia (`src/shared/lore.ts`: GUIDES für Orchestratoren, CAST für
Subagenten), **Workspaces** tragen Commedia-Orte
(`src/shared/workspaceNames.ts`: Paradiso, Purgatorio, Inferno, …). Die
Commedia (1320) ist gemeinfrei.

## Das Zeichen: „Fusione"

Der Windhund im gestreckten Galopp. Zwei Verdigris-Tempolinien schneiden als
Schlitze durch Lende und Kruppe, die Rute läuft in eine dritte Linie aus, eine
vierte zieht hinter den Läufen her — vorne massiv Bronze, hinten löst er sich
in Tempo auf. Optional umschließt eine Stadion-Kontur (Rennbahn) das Zeichen.

- Quelle im Repo: `build/icon.svg` (OS-Icon, Verdigris-Kachel) und die
  React-Komponente `src/renderer/src/components/HoundLogo.tsx` (Token-basiert).
- Icons werden ausschließlich aus `build/icon.svg` generiert:
  `pnpm run icons` (ICO/ICNS/PNGs/Favicon).
- Wortmarke: **VERTRAGVS** (klassisches V für U, wie auf römischen
  Inschriften), Untertitel „Agent Orchestration".

## Palette

| Token | Hex | Rolle |
| --- | --- | --- |
| Bronze | `#CBA35A` | Akzent Dark; Hund, Orchestrator, Entscheidungen |
| Alt-Bronze | `#936C2B` | Akzent Light |
| Verdigris | `#2F7D6D` | Tempo/„läuft"-Zustände Dark (`--sage`) |
| Verdigris (Light) | `#1E5148` | dito Light |
| Tiefes Verdigris | `#0C2925` | Grounds (App-Icon-Kachel) |
| Graphit | `#20242B` | Dark-Flächenfamilie |
| Vellum | `#EDE8DD` | Light-Flächenfamilie; Haftnotizen |

**Kernregel:** *Verdigris pulsiert, wo gearbeitet wird* (laufende Kanten,
Heartbeat-Punkte, Progress, Recording-Waveform). *Bronze markiert
Orchestrator und Entscheidungen.* Verdigris ist die Patina von Bronze — die
Palette altert in sich selbst.

## Abgrenzung

Der laufende Windhund ist als Motiv verbreitet (u. a. Greyhound Lines).
Unsere Unterscheidungsmerkmale, die im Feinschliff erhalten bleiben müssen:
die **integrierten Tempo-Schlitze**, die **in die Linie auslaufende Rute**,
das sichtbare angelegte Ohr und die Farbwelt **Bronze/Verdigris** statt
Weiß/Blau.

## Offene formale Schritte (vor einem öffentlichen Release)

- [ ] Markenrecherche + ggf. Anmeldung **Klasse 9/42** (EUIPO, USPTO) für
      „Vertragus" — Stand der informellen Recherche (Juli 2026): im
      KI-/Software-Raum frei; Treffer nur Windhund-Zuchten (`vertragus.it`,
      Kennel PL) und Historisches.
- [ ] Domains beim Registrar prüfen/sichern: `vertragus.dev`, `vertragus.ai`
      (im Juli 2026 ohne aktive Sites).
- [ ] npm-Paketname `vertragus` und GitHub-Org-Verfügbarkeit prüfen.
- [ ] **Logo-Vektor-Feinschliff** in einem Vektor-Werkzeug: Kurven der
      Silhouette glätten, Schlitzkanten sauber verrunden, optische Korrektur
      der Pfoten — die aktuelle Kurve ist eine Konzept-Skizze.
- [ ] Icon-Sonderformate: macOS-Squircle-Feinschliff, Windows-Kachelfarben.

## Interne Bezeichner (Migration & Legacy)

Migriert, Legacy weiter erkannt: das Worktree-Verzeichnis `.vertragus-worktrees/`
und das Branch-Präfix `vertragus/` sowie der Subagent-MCP-Server `vertragus-sub`
(`mcp__vertragus-sub__*`) sind kanonisch; die Alt-Namen `.orca-worktrees/`,
`orca/` und `mcp__orca-sub__*` werden für bestehende Workspaces weiterhin
erkannt und aufgeräumt (kein Datenverlust, keine physische Migration). Die
In-Process-Renderer-Bridge ist migriert: `window.vertragus` mit den Typen
`VertragusApi` / `VertragusEvent` (Preload + Renderer werden gemeinsam gebaut
und die Bridge bei jedem Start neu aufgebaut, daher kein Legacy-Fallback nötig).

Bewusst noch alt (Bruchgefahr für bestehende Workspaces und bereits gekoppelte
PWAs): die persistenten Verzeichnisse `.orca-runtime/` und `orca-handoffs/`, die
Klassennamen `OrcaMcpServer`/`OrcaTask`, die electron-store-Namen
`orca-strator` / `orca-inbox`, die
`mcp__orca__*`-Toolnamen, die WebSocket-Protokolle `orca-v1` / `orca-bearer.*`,
die Push-Tag-Legacy `orca-remote` und die `orca.*`-localStorage-Fallbacks der
PWA bleiben bis zu einem eigenen Migrations-Release stabil.

Env-Flags sind migriert: kanonisch `VERTRAGUS_*`, `ORCA_*` wirkt als
Fallback (`src/main/env.ts`, `scripts/brandEnv.ts`).
