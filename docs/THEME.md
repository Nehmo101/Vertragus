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
höher-/gleichrangigen Selektoren. Zusätzlich streuen in styles.css und
canvas.css noch dutzende Roh-Hex-Werte in Regeln (u. a. `#f5a524`/`#f7c96b`
— jetzt als `--attn`/`--attn-text` tokenisiert, die alten Regeln nutzen aber
noch die Literale — sowie `#2dd4bf`-Gradients, `#04121a`-on-accent-Texte,
`#c0333a`-Danger-Flächen).

Empfohlenes Vorgehen für die Konsolidierung (bewusst nicht im Rahmen der
Token-Hygiene erledigt, weil es Regel-Umbauten erfordert):

1. **Inventar:** `grep -E '#[0-9a-fA-F]{3,8}' src/renderer/src/*.css` — je
   Fundstelle klären, ob die Regel im Light-/Dark-Theme überhaupt noch
   sichtbar ist (viele styles.css-Regeln sind vollständig von cozy-organic
   überdeckt).
2. **Tote Regeln löschen** statt tokenisieren (Screenshot-Vergleich Light +
   Dark vor/nach jedem Block).
3. Verbleibende styles.css-Literale auf die vorhandenen Token bzw. die
   Compatibility-Aliases umstellen — dabei gilt weiter: exakt gleicher
   Farbwert oder neues Token, keine stille Umfärbung.
4. Ziel-Endzustand: styles.css enthält nur noch Layout/Struktur plus
   `:root`-Fallback-Token, alle Farbentscheidungen leben in cozy-organic.css.
