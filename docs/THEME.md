# Theme- und Token-Architektur

Stand: 28. Juli 2026. Ergänzt [Marke & Design](./BRAND.md) um die technische
Seite: wo Farb-Token definiert sind, wie das Theming funktioniert und welche
Regeln beim Stylen von Komponenten gelten.

## Schichten und Ladereihenfolge

Die Stylesheets laden in `src/renderer/src/main.tsx` in fester Reihenfolge:

1. `styles.css` (~5600 Zeilen) — Basis aus dem ursprünglichen Design-Handoff.
   Definiert unter `:root` den historischen (dunklen, türkisfarbenen)
   Token-Satz **und** den Großteil der Komponenten-Selektoren.
2. `cozy-organic.css` — das aktive Theme, lädt danach und gewinnt bei gleicher
   Spezifität. Definiert unter `.app-root` den Light-Token-Satz (warme
   Papier-/Bronze-/Verdigris-Palette) und unter
   `.app-root[data-theme='dark']` die Dark-Overrides. Am Ende des Light-Blocks
   liegen **Compatibility-Aliases** (`--bg-app`, `--text-1`, `--ok`, `--warn`,
   `--danger-*` …), die die alten styles.css-Namen auf die neuen Token mappen —
   Komponenten, die noch alte Namen referenzieren, bekommen so automatisch die
   cozy-Farben.
3. `canvas.css` + `assets/canvas-chat.css` — Canvas-spezifische Styles.
4. CSS-Module (`*.module.css`) — komponenten-lokale Styles, importiert von der
   jeweiligen Komponente.

Das Theme wird in `App.tsx` als `data-theme={store.theme}` auf `.app-root`
gesetzt (nicht auf `<html>`). Alle Token leben deshalb auf `.app-root`, nicht
auf `:root` — Portale müssen unter `.app-root` mounten (siehe
`useAppRootPortalTarget`).

## Namenskonventionen

- **Flächen:** `--ambient`, `--bg`, `--panel`, `--surface`, `--surface-2`,
  `--pane`, `--inset`, `--terminal` (Terminal-Hintergrund, bewusst in beiden
  Themes dunkel).
- **Text:** `--text`, `--text-2`, `--text-3`, `--text-faint`; Terminal-Text
  über `--term-*`.
- **Akzente:** `--accent` (Bronze) mit `-hover`, `-strong`, `-soft`,
  `-soft-text`, `-line` und `--on-accent` (Text auf Akzentfläche); `--sage`
  (Verdigris) mit `-strong`, `-soft` und `--on-sage`.
- **Status:** je Zustand ein Trio `--run/--run-text`, `--wait/--wait-text/--wait-soft`,
  `--err/--err-text/--err-soft/--err-line`, `--stop/--stop-text/--stop-soft`.
  Das TS-Gegenstück ist `STATUS_THEME` in `src/renderer/src/ui/theme.ts`.
- **Provider-Chips:** `--prov-claude`, `--prov-kimi`, `--prov-codex`,
  `--prov-cursor`, `--prov-ollama`, `--prov-github`, `--prov-cloudflare` —
  markennahe Farben, je Theme abgestimmt. `PROVIDER_THEME` in `ui/theme.ts`
  referenziert ausschließlich diese Token (Label/Monogramm sind bewusst
  Konstanten im TS — das sind Markenzeichen, keine Theme-Werte).
- **Theme-invariante Einzelfarben** (in beiden Themes identisch, aus früheren
  Inline-Hex gehoben): `--attn`/`--attn-text` (Amber für „braucht
  Aufmerksamkeit": pausiert/wartend/needs-work), `--on-sage` (Text auf
  Sage-Chip), `--mcp-dot-on`/`--mcp-dot-off` (MCP-Statuspunkte). Sie sind
  dreifach definiert: `styles.css :root` (Fallback) sowie cozy-Light- und
  Dark-Block — bei Wertänderung alle drei Stellen pflegen.

## Do / Don't

**Do**

- Farben in Komponenten (TSX wie CSS-Module) immer als `var(--token)`
  referenzieren; Abtönungen über `color-mix(in srgb, var(--token) N%, transparent)`
  sind ausdrücklich ok.
- Neue Komponenten-Styles in ein CSS-Modul neben die Komponente legen, nicht
  in styles.css anbauen.
- Fehlt ein passendes Token: neues semantisches Token in cozy-organic.css
  (Light **und** Dark) plus styles.css-Fallback anlegen, dann referenzieren.
- `var(--token, #fallback)`-Fallbacks in CSS-Modulen sind harmlos (greifen nur
  ohne geladenes Theme), sollten aber nicht als Ersatz für echte Token dienen.

**Don't**

- Keine Inline-Hex-Werte in TSX (`style={{ color: '#…' }}`) — das war die
  Hauptquelle der Token-Drift.
- Keine neuen Regeln in styles.css für neue Features (nur additive
  Token-Definitionen); keine Doppelpflege alter und neuer Token-Namen in
  neuem Code — die neuen cozy-Namen verwenden.
- `--err`/`--ok` & Co. nicht mit den styles.css-Rohwerten verwechseln:
  cozy-organic remappt die Alias-Namen (`--ok` → `--run` usw.). Wer den
  exakten alten Handoff-Wert braucht, braucht ein eigenes Token.

## Bekannte, dokumentierte Ausnahmen (keine Verstöße)

- **`ui/theme.ts` → `XTERM_THEME`/`resolveXtermTheme()`:** xterm.js kann keine
  CSS-Variablen auflösen. `resolveXtermTheme()` liest die Terminal-Palette zur
  Laufzeit per `getComputedStyle` aus dem **Dark**-Token-Block (Probe-Element
  `.app-root[data-theme='dark']`) — das Terminal ist auch im Light-Theme
  dunkel, ein Update bei Theme-Wechsel ist deshalb unnötig. Die Literale in
  `XTERM_THEME` sind der Fallback für DOM-lose Umgebungen (vitest läuft in
  plain node); jede Zeile nennt im Kommentar ihr Quell-Token. Vier Slots
  (`selectionBackground`, `magenta`, `brightCyan`, `brightWhite`) sind
  xterm-eigene Akzente ohne Token.
- **`canvasGraph.ts` (Pfeilspitzen):** React-Flow-SVG-Marker können keine
  CSS-Variablen auflösen; die drei Mitteltöne sind als Konstanten dokumentiert
  und funktionieren auf beiden Themes.
- **`HoundLogo.tsx` (Maske):** `#fff`/`#000` in der SVG-Maske sind
  Luminanz-Werte (weiß = sichtbar, schwarz = Schlitz), keine Theme-Farben.
- **YOLO-Warn-Optik** (`TitleBar.module.css`, `.yolo-strip` in styles.css):
  bewusst themen-invariante literale Rottöne (#f2555a-Basis, #ff6b70-Text).
  Nicht auf `var(--err)` umstellen — cozy-organic überschreibt `--err` und
  würde die Optik ändern.

## Altlasten (offenes Wochen-Projekt)

styles.css und cozy-organic.css pflegen teils dieselben Oberflächen doppelt:
styles.css definiert Regel + alten Hex-Wert, cozy-organic überschreibt mit
höher-/gleichrangigen Selektoren. Ein erster konservativer Durchgang ist
erledigt (siehe „Konsolidierung 2026-07-28" unten); es verbleiben Roh-Hex-
Werte in styles.css-Regeln, deren Substitution NICHT beweisbar optik-neutral
ist, weil die passenden Token je Theme unterschiedliche Werte tragen:

- **`#2dd4bf`/`#22d3ee`/`#1c8fb0`/`#1c9fb8`-Gradients** (`.btn-primary`,
  `.orch-diamond`, `.orch-block .avatar`, `.modal-gear`, `.goal-bar-fill`,
  `.task-bar-fill`): alter Handoff-Akzent; `--accent` ist heute Bronze und
  je Theme verschieden. Viele dieser Regeln sind von cozy-organic überdeckt —
  klären, ob die Regel je Theme noch sichtbar ist, dann löschen statt
  tokenisieren (Screenshot-Vergleich Light + Dark).
- **`#04121a`/`#06121a`-on-accent-Texte** (7×/2×): `--on-accent` ist
  `#fbf6ea` (Light) bzw. `#1d1a12` (Dark) — keine wertgleiche Substitution
  möglich.
- **`#c0333a`-Danger-Flächen** (`.win-btn.close:hover`, `.btn-danger`,
  `.slot-yolo.on`): kein Token trägt exakt diesen Wert.
- **`#3fd17a` (`.github-auth-ok`) / `#e9b949` (`.github-auth-warn`)**:
  wertgleich zu `--mcp-dot-on` bzw. altem `--warn`, aber semantisch fremd
  (`--ok`/`--warn` sind per Alias auf `--run`/`--wait` remappt) — bei Bedarf
  eigenes Token anlegen.
- **Rest-Grautöne** `#a9b6c9`, `#8fa0b6`, `#8b98ad`, `#4a5a70` u. a. in
  Dispatch-/Pane-Regeln: alte Handoff-Textfarben ohne wertgleiches Token.
- **canvas.css**: alle 15 verbliebenen Hex sind absichtlich themen-invariant
  (Vellum-Notizzettel `.canvas-node--note` inkl. `kind-*`-Chips, deren
  Werte den *Light*-Werten von `--err`/`--accent`/`--sage` entsprechen, im
  Dark-Theme aber bewusst NICHT mitwandern sollen; plus ein `#000`-Schatten).
  Nicht tokenisieren.

Ziel-Endzustand bleibt: styles.css enthält nur noch Layout/Struktur plus
`:root`-Fallback-Token, alle Farbentscheidungen leben in cozy-organic.css.

### Spezifitätskonflikte mit cozy-organic (Ist-Stand 2026-07-28)

Vier CSS-Module erhöhen gezielt die Spezifität, um Regeln zu schlagen, die
cozy-organic (lädt zuletzt) auf gleicher Ebene definiert. Vorlage für einen
künftigen gezielten Umbau (z. B. Layer/`@layer` oder Verschieben der
Theme-Regeln in die Module):

- **responsiveGuards.module.css** (`@media ≤1240px`):
  `.titlebar:global(.titlebar)` (0,2,0) setzt `gap: 8px` gegen cozy-organics
  `.titlebar { gap: 13px }` (0,1,0). Bei gleicher Spezifität gewann das Theme
  und die 13px-Gaps drückten die Fensterknöpfe über den rechten Rand
  (Fenster-Minimum 900px).
- **InboxPanel.module.css**: `.panel .splitBody.splitBody` (0,3,0) besitzt
  die Grid-Spalten gegen styles.css `.inbox-body { 240px 1fr }` (0,1,0) und
  responsiveGuards' Re-Deklaration unter 720px (0,2,0).
- **TitleBar.module.css**: `.yoloMaster:global(.yolo-btn.on)` (0,3,0) legt
  die themen-invariante YOLO-Warn-Optik über die Theme-Regel `.yolo-btn.on`
  (0,2,0) aus cozy-organic.
- **SessionRestoreBanner.module.css**:
  `:global(.restore-banner) :global(.btn).dangerAction` (0,3,0) schlägt den
  Button-Reset `.restore-banner .btn` (0,2,0) aus styles.css.

## Konsolidierung 2026-07-28 (Welle 5)

Konservativer erster Durchgang, ausschließlich beweisbar optik-neutrale
Schritte; verifiziert mit `typecheck:web`, vollem Renderer-Vitest-Lauf und
E2E-Smoke (12 Ansichten).

**Wertgleiche Token-Substitution** (Token in Light, Dark und
`:root`-Fallback identisch → keine Theme-Abhängigkeit):

- styles.css: 10 Ersetzungen — 5× `#f5a524` → `var(--attn)`
  (`.finding-entry.kind-decision .finding-kind`, `.task-criticality`,
  `.task-findings`/`.task-blocker` Border+Fläche, `.retro-down`) und
  5× `#f7c96b` → `var(--attn-text)` (dieselben Kontexte plus
  `.reliability-strip .warn`, `.plan-review-warning`).
- canvas.css: 0 (alle Hex dort sind absichtliche Vellum-Invarianten, s. o.).

**Nachweislich tote Regeln entfernt** (Beweis: exakte Klassennamen kommen in
keinem `.tsx/.ts/.html/.js/.mjs` im Repo vor — `grep -rF '<klasse>'` ohne
node_modules/dist/out = 0 Treffer — und kein dynamisches Präfix aus dem
Inventar `grep -ohE "[a-z-]+-\$\{"` kann sie erzeugen):

- styles.css: 62 Regeln (~425 Zeilen) zu 34 toten Klassen: `.logo-badge`,
  `.readable-btn`/`.readable-check` (6), `.profile-btn`/`.profile-avatar`
  (5), `.restore-dismiss`, `.ws-header .crumb/-root/-sep` (3), `.wt-tag`,
  `.findings-board-head`, `.retro-card` (2), `.retro-body`, `.dag-caption`
  (2), `.dispatch-head` (4), `.density-btn` (3), `.github-project-field/
  -owner-row/-select` (5), `.github-repo-actions`, `.agent-branch-tag`,
  `.self-update-btn` (6), `.inbox-prompt-preview(-head)` (3), `.voice-target/
  -label/-state/-record/-settings/-error(-action)` (14), `.remote-error`,
  `.mission-error`; dazu `.live-activity-caption` aus zwei Selektorlisten
  entfernt (`.live-workers-head` bleibt).
- cozy-organic.css: 18 Regeln zu denselben toten Klassen
  (`.voice-target-switch/-btn` (5), `.profile-btn/-avatar` (3), `.wt-tag`,
  `.dag-caption` (2), `.dispatch-head` (3), `.self-update-btn` (4)); dazu
  tote Selektoren aus 4 Listen entfernt (`.agent-branch-tag` 2×,
  `.wt-tag` 1×, `.dispatch-head .clock` 1×, `.github-project-field` 1×).
- Bewusst NICHT gelöscht trotz 0 Literal-Treffern: dynamisch erzeugte
  Klassen (`layout-${…}`, `workspace-${…}`, `kind-${…}`, `tone-${…}`,
  `state-${…}`, `status-${…}`, `phase-${…}` — z. B. `.layout-canvas`,
  `.workspace-focus`, `.kind-budget-exceeded`, `.tone-dispatch`) sowie
  Drittanbieter-Laufzeitklassen (`.react-flow__*`, xterm).

**Verbleibende Roh-Hex-Zählung** (`grep -oE '#[0-9a-fA-F]{3,8}' | wc -l`):
styles.css 97 (davon 39 in den `:root`-Token-Definitionen und 4 als
`var(--sage, #1e5148)`-Fallbacks), canvas.css 15 (alle dokumentiert
invariant), cozy-organic.css 97 (Token-Definitionen des aktiven Themes —
dort gehören sie hin).
