Deutsch | [English](REMOTE-CLIENT-SCROLL.md)

# Remote-Client: warum er weiter nicht scrollt, und was zu ersetzen ist

Am Code festgemachte Analyse von `src/remoteClient` zum Stand Commit
`bbc5300`, geschrieben nach den vier Durchgängen in
[REMOTE-CLIENT-MOBILE.md](REMOTE-CLIENT-MOBILE.md). Jenes Dokument erzählt,
was versucht wurde; dieses sagt nur, was im jetzt existierenden Code weiter
falsch ist, und was zu ersetzen ist. Zeilennummern beziehen sich auf die
Dateien in diesem Commit.

## 1. Urteil

Der Terminal-Verlauf kann sich nicht nativ anfühlen, weil jedes Pixel seiner
Bewegung auf dem Hauptthread von einer handgeschriebenen Gesten-Engine
erzeugt wird, die dem Browser das Pannen bewusst verbietet (`touch-action:
pinch-zoom` auf Bühne, Host und Viewport), und kein Nachjustieren ändert
diese Obergrenze. Dasselbe Terminal wird außerdem neu eingepasst, umgebrochen
und das gemeinsame PTY in der Größe geändert von Dingen, die gar keine
Viewport-Änderungen sind (die Sprung-Pillen, die Tastenzeile, ein Pinch,
jeder Tastatur-Animationsframe), und es zeichnet auf einem lokalen Gitter,
das vom PTY abweicht — deshalb sieht TUI-Ausgabe auf dem Handy falsch aus.
Der Dokument-Scroll der Übersicht ist das richtige Design, aber der
Pull-to-Refresh-Hook rendert die ganze App bei jeder Touch-Bewegung am
Anfang der Liste neu und schiebt Layout-Höhe vor einen nativen Pan, den iOS
schon begonnen hat, sodass der häufigste Flick, der vom Anfang, der ist, der
sich falsch verhält. Die Tastaturbehandlung positioniert ein fixes Overlay
aus JavaScript einen Frame hinter dem Browser und passt das Terminal auf
jedem Frame der Tastatur-Animation neu ein, sodass der Composer schwimmt und
der Puffer umbricht, während die Tasten aufgehen. Die Empfehlung ist
strukturell: den Scrollback als normalen DOM-Text in einem nativen Scroller
zeichnen, gespeist von einem kopflosen xterm-Parser in der Größe des PTY,
die Gesten-Engine, das lokale Fit und das Viewport-Hinterherlaufen löschen,
und die Pull-Geste aus der Übersicht löschen.

## 2. Befunde

Jeder Befund nennt das Symptom auf dem Handy, den Mechanismus mit Zitaten
und eine Konfidenz. "Hoch" heißt, der Mechanismus steht direkt im Code oder
im xterm-5.5.0-Bundle; "mittel" heißt, der Code ist sicher, die Schwere auf
dem Gerät aber aus dem Plattformverhalten geschlossen, nicht gemessen.

### 2.1 Terminal-Verlauf

**T1. Ein in JS synthetisierter Pan kann auf keinem Handy nativ sein.**
Symptom: der Drag hängt nach, der Fling bremst auf einer Kurve, die nicht
die der Plattform ist, es gibt kein Gummiband, keine Scrollbar, und ein
schneller Flick verliert Frames.
Mechanismus: Bühne, Host und Viewport erklären alle `touch-action:
pinch-zoom` (`src/remoteClient/terminal.css:266`, `:293`, `:330`), sodass
der Compositor nie pannen darf. Jedes Touchmove läuft stattdessen
`onTouchMove` und dann `paintScroll`
(`src/remoteClient/RemoteTerminal.tsx:766-794`, `:681-703`): ein
`scrollTop`-Schreiben, ein Transform auf `.xterm-screen`, xterms eigenes
`_handleScroll` in `scrollLines`, ein Neuzeichnen jeder Zeile durch den
DOM-Renderer, dann Layout und Paint, alles auf dem Hauptthread, pro Event.
Der Nachlauf ist eine `requestAnimationFrame`-Schleife
(`RemoteTerminal.tsx:710-733`, `src/remoteClient/terminalScroll.ts:294-308`)
mit einer Reibungskonstante (`terminalScroll.ts:67`). Das Stylesheet gibt
die Kosten schon zu: das Handy sieht nie eine Scrollbar, weil nichts Natives
das Element je scrollt (`terminal.css:318-325`). Die eigene Lehre des Repos,
dass Safari in dem Moment einen nativen Pan startet, in dem `pan-y` gewährt
wird, und dann `preventDefault` ignoriert (`terminal.css:37-39`), ist genau
der Grund, warum dieses Design den Pan verweigern muss, und deshalb warum es
den Compositor nie nutzen kann. Konfidenz: hoch.

**T2. Das Terminal wird neu eingepasst, umgebrochen und das PTY in der Größe
geändert von Dingen, die keine Viewport-Änderungen sind.**
Symptom: die Stelle des Lesenden springt; die Desktop-Kopie der Agent-TUI
zeichnet neu, wenn das Handy bloß zum Anfang scrollt oder die Tastenzeile
öffnet.
Mechanismus: `has-jumps` legt 56 px Padding auf den Host
(`terminal.css:269-271`, gesetzt in `RemoteTerminal.tsx:1257`, sobald der
Lesende nicht ganz oben ist oder nicht folgt). Der `ResizeObserver` auf dem
Host (`RemoteTerminal.tsx:950-951`) feuert, `requestFit('viewport')` führt
`fit.fit()` plus ein zweites `term.resize` für die Overscan-Zeile aus
(`:533-539`), verwirft die Pan-Position und die Teilzeilen-Transformation
(`:543-545`), und `hostResize` schickt die neue Größe an das PTY, weil die
Ursache weder lokal noch transient ist (`:546-559`,
`src/remoteClient/terminalResize.ts:54-64`). Dieselbe Kette läuft, wenn die
Tastenzeile ein- oder ausklappt (`terminal.css:461-463`), wenn die Suchleiste
schließt (`RemoteTerminal.tsx:1210-1252`; nur die offene Hälfte gilt als
transient, weil `ownFieldRef` `searchOpen` folgt, `:481-487`), und wenn die
Eingabeleiste auf kompaktem Chrome erscheint (`terminal.css:592-604`). Jedes
Fit umbricht einen 5000-Zeilen-Puffer zweimal. Der Desktop besitzt dasselbe
PTY und passt es an seinem eigenen `ResizeObserver` ein
(`src/renderer/src/terminal/TerminalApp.tsx:341-342`, `:373`), sodass zwei
Clients sich abwechseln, einen gemeinsamen Prozess in der Größe zu ändern.
Konfidenz: hoch für den Mechanismus; mittel dafür, wie oft der Benutzer den
Sprung darauf zurückführt.

**T3. Das lokale Gitter ist nicht das Gitter des PTY, deshalb wird
TUI-Ausgabe falsch gezeichnet.**
Symptom: die Ink-Oberfläche von Claude Code zeigt auf dem Handy doppelte
oder zerrissene Zeilen; die neueste Zeile ist oft verdeckt; bei offener
Tastatur zeigt das Terminal ein paar Zeilen eines dreißigzeiligen Programms.
Mechanismus: der Snapshot trägt `cols` und `rows` des PTY
(`src/shared/remote/protocol.ts:195-196`, gefüllt in
`src/main/remote/terminalBridge.ts:191-192`) und der Client ignoriert beide
(`RemoteTerminal.tsx:912`, `_cols, _rows`). Das Handy passt xterm stattdessen
an die eigene Breite an, und `terminalResize.ts:20-25` dokumentiert die
entstehende Abweichung als "a slightly early wrap". Das gilt für ein
schlichtes Log und nicht für eine TUI: relative Cursorbewegung und
Zeilenlösch-Sequenzen setzen die Breite des PTY voraus, sodass ein schmaleres
lokales Gitter mitten in der Sequenz umbricht und das Neuzeichnen auf den
falschen Zeilen landet. Wenn ein Fit als transient abgelehnt wird
(`terminalResize.ts:113-116`, `MIN_HOST_ROWS` bei `:37`), wird das lokale
Terminal trotzdem auf die kleine Größe gesetzt (`RemoteTerminal.tsx:535`),
sodass das PTY dreißig Zeilen in ein lokales Acht-Zeilen-Gitter zeichnet.
Getrennt davon macht die Overscan-Zeile (`terminalScroll.ts:316-329`,
angewendet in `RemoteTerminal.tsx:539`) das lokale Gitter eine Zeile höher,
als das PTY glaubt, und `.terminal-host` / `.xterm` schneiden diese Zeile ab
(`terminal.css:278`, `:297-302`): ein Programm, das seine neueste Zeile in
die letzte Zeile des PTY schreibt, landet sie in der abgeschnittenen Zeile,
bis der nächste Zeilenvorschub sie hochschiebt. Konfidenz: hoch für den
Mechanismus; mittel-hoch, dass dies das Zerhacken ist, das der Benutzer bei
Ink-basierten Agenten sieht.

**T4. Pinch-Zoom wird gewährt und dann ausgehebelt.**
Symptom: ein Pinch auf dem Terminal verkleinert das Terminal, statt es zu
vergrößern.
Mechanismus: ein Pinch ändert `visualViewport.height` und `offsetTop`; der
Hook schreibt `--vv-height` und `--vv-offset-top` neu
(`src/remoteClient/useVisualViewport.ts:196-204`); das Overlay wird darüber
dimensioniert und platziert (`terminal.css:53`, `:65`); der Host schrumpft;
der `ResizeObserver` und der `visualViewport`-`resize`-Listener
(`RemoteTerminal.tsx:950-953`) passen xterm auf weniger Spalten ein. Die
Verschiebung liegt üblicherweise über `KEYBOARD_MIN_PX`
(`terminalResize.ts:73`), sodass das PTY verschont bleibt, aber der lokale
Puffer umbricht in die gezoomte Box, das Gegenteil eines Zooms. Das
A−/A+-Paar im Kopf (`RemoteTerminal.tsx:1176-1193`) existiert deswegen.
Konfidenz: mittel-hoch.

**T5. xterm schnappt `scrollTop` im nächsten Frame auf eine Zeile; ein
nativer Pan von `.xterm-viewport` stottert deshalb.**
Das ist die Tatsache hinter dem vierten Durchgang und der Grund, warum
Alternative (a) in Abschnitt 3.2 verworfen wird. Im 5.5.0-Bundle
(`node_modules/@xterm/xterm/lib/xterm.js`, Klasse `Viewport`):
`syncScrollArea` ruft `_refresh` auf, sobald `_lastScrollTop` von
`ydisp * rowHeight` abweicht; `_innerRefresh` schreibt
`scrollTop = ydisp * rowHeight` mit gesetztem `_ignoreNextScrollEvent`;
`_handleScroll` rundet `scrollTop / rowHeight`, um `ydisp` zu wählen. Jede
Position innerhalb einer Zeile, nativ oder per Skript, wird innerhalb eines
Frames eingeschnappt. xterms eigene Touch-Handler (`touchstart` passiv und
`touchmove` nicht-passiv auf `term.element`) addieren `scrollTop += delta`
oben drauf, was auch sonst bewegt. Konfidenz: hoch.

**T6. Das Handy läuft mit xterms DOM-Renderer.**
Es wird kein Renderer-Addon geladen (`RemoteTerminal.tsx:45-47`; der Desktop
lädt `WebglAddon`, `TerminalApp.tsx:11`, `:60`). Jede `ydisp`-Änderung baut
die Zeilenelemente neu. `src/remoteClient/styles.css:64-70` behauptet, xterm
"renders into a canvas that no CSS rule can reach"; auf diesem Client gilt
das nicht. Konfidenz: hoch.

**T7. Ein Terminal zu öffnen gibt kein Feedback.**
Symptom: ein Tippen auf eine Agentenzeile tut über Tailscale bis zu ein, zwei
Sekunden lang nichts Sichtbares.
Mechanismus: `.agent-row` hat keinen `:active`-Style
(`src/remoteClient/overview.css:487-499`; vergleiche `.primary:active` bei
`styles.css:410-412`); der Suspense-Fallback ist eine nackte Hintergrundbox
(`src/remoteClient/App.tsx:457`, `overview.css:77-85`); vor dem ersten Paint
muss der Client den Terminal-Chunk laden, anhängen, einen Snapshot von bis
zu 2 MB empfangen und parsen (`RemoteTerminal.tsx:923`) und einpassen.
Konfidenz: hoch.

### 2.2 Übersicht

**O1. Pull-to-Refresh rendert die App bei jeder Touch-Bewegung am Anfang und
schiebt Höhe vor einen nativen Pan.**
Symptom: ein Flick, der am Anfang der Liste beginnt, bewegt doppelt, dann
springt beim Loslassen; die Liste fühlt sich genau dort klebrig an, wo der
Benutzer am häufigsten landet.
Mechanismus: der Window-`touchmove`-Listener
(`src/remoteClient/usePullToRefresh.ts:499`) ruft bei jeder Bewegung
`track()` auf, solange er noch im Slop ist (`:480-482`), und `track` ist
`setDistance` (`:430-438`): ein React-Render von `App` und jeder Karte pro
Touch-Event. Der Indikator, dessen Höhe dieser State treibt, ist ein
In-Flow-Block über `<main>` (`App.tsx:729-736`, `overview.css:137-144`),
sodass die Liste unter dem Finger nach unten geschoben wird, während der
Browser sie pant. Auf iOS hat die erste nicht abgebrochene Bewegung (der
Slop ist 8 px, `:55`) die eigene Geste des Root-Scrollers schon gestartet;
`overscroll-behavior: contain` (`styles.css:194`) stoppt das Chaining, nimmt
dem Root aber nicht das Gummiband, und das spätere `preventDefault` des
scharfen Listeners (`:400-402`) wird für den Rest dieser Geste ignoriert,
dieselbe Regel, die das Terminal-Stylesheet bei `terminal.css:37-39`
festhält. Beim Loslassen hält der Streifen 34 px für mindestens 700 ms
(`:334-339`, `:289`), während das Gummiband zurückschnappt. Konfidenz: hoch
für das Render-pro-Move und das Einschieben von Layout; mittel für das
genaue iOS-Zusammenspiel.

**O2. Jeder Touch-Start läuft die Vorfahrenkette mit `getComputedStyle` ab.**
`gestureChain` (`usePullToRefresh.ts:200-220`) erzwingt Style auf jedem
Element vom berührten Knoten bis zur Wurzel, synchron, am Start jeder Geste
in der App. Klein, aber es sitzt auf dem kritischen Pfad jedes
Scroll-Starts. Konfidenz: mittel.

**O3. Paint-lastiges Chrome läuft, während die Liste scrollt.**
Der sticky Kopf und der Zurück-nach-oben-Button nutzen
`backdrop-filter: blur(16px)` (`styles.css:452`, `overview.css:830`); jeder
arbeitende Agentenpunkt und jeder Attention-Punkt läuft eine unendliche
`box-shadow`-Keyframe-Animation (`overview.css:513-519`, `:362-368`,
`styles.css:295-316`). `box-shadow` ist keine Compositor-Eigenschaft,
deshalb zeichnet jeder Frame neu, und eine Liste mit mehreren arbeitenden
Agenten zeichnet während eines Scrolls durchgehend neu. Konfidenz: mittel.

**O4. Höhen über dem Finger ändern sich unter ihm.**
Kartenrümpfe entstehen nur, solange sie aufgeklappt sind
(`App.tsx:1423-1424`), der Fragen-Eingang und die Abschnitte ungesendeter
Entwürfe erscheinen und verschwinden mit der Leitung (`App.tsx:737-752`),
und ein `workspaces`-Push ist ereignisgetrieben, nicht getaktet
(`src/main/remote/server.ts:404-408`). Safari hat kein Scroll-Anchoring,
sodass jedes davon oberhalb des Viewports die Stelle des Lesenden
verschiebt. Konfidenz: mittel.

Was in der Übersicht richtig ist und nicht angefasst werden darf: das
Dokument ist der Scroller, `html` trägt `overflow-y: auto` und
`overflow-x: clip`, `body` hat kein eigenes Overflow, der Kopf ist sticky,
die Liste hat keine innere Overflow-Box (`styles.css:183-215`,
`overview.css:164-173`). Die versteckte, nicht abgehängte Übersicht unter
dem Terminal (`App.tsx:421-428`, `overview.css:42-58`) ist ebenfalls
richtig, und `useDocumentScrollLock` (`App.tsx:534-547`) ist ein tragfähiger
Gürtel dafür.

### 2.3 Tastatur, Composer, Visual Viewport

**K1. Das Terminal-Overlay läuft dem Visual Viewport aus JavaScript
hinterher, einen Frame zu spät, und passt auf jedem Frame der
Tastatur-Animation neu ein.**
Symptom: wenn der Composer fokussiert ist, schwimmt das ganze Terminal für
die Dauer der Tastatur-Animation, die Eingabeleiste liegt zeitweise unter
den Tasten, und der Puffer umbricht sichtbar.
Mechanismus: `--vv-offset-top` und `--vv-height` werden aus einem
`requestAnimationFrame` nach jedem `visualViewport`-Event geschrieben
(`useVisualViewport.ts:216-222`, `:191-207`); `top` und `height` des
Overlays sind diese Variablen (`terminal.css:53`, `:65`).
`overview.css:27-35` dokumentiert den entstehenden unbedeckten Streifen.
Jedes `visualViewport`-`resize` ruft außerdem `requestFit('viewport')` auf
(`RemoteTerminal.tsx:953`), sodass xterm auf jedem Animationsframe, in dem
sich die Höhe geändert hat, neu eingepasst wird. Konfidenz: hoch.

**K2. iOS ignoriert `interactive-widget=resizes-content`.**
`src/remoteClient/index.html:44` verlangt einen sich verkleinernden
Layout-Viewport; nur Android Chrome hält sich daran. Auf iOS schrumpft der
Layout-Viewport nie; mit `html` auf `overflow: hidden` unter dem Terminal
(`App.tsx:540`) kann Safari das Dokument nicht scrollen, um die Eingabe
sichtbar zu machen, also verschiebt es stattdessen den Visual Viewport, den
"shift state", den das Policy-Modul beschreibt
(`src/remoteClient/revealPolicy.ts:259-279`). Dieser Zustand wird behandelt,
aber nur durch das Hinterherlaufen in K1. Konfidenz: hoch.

**K3. Das Reveal der Übersicht ist zweistufig.**
`revealFocus` wartet 140 ms (`useVisualViewport.ts:54`) nach dem letzten
Wachstumsschritt und scrollt dann um das Zentrier-Delta
(`revealPolicy.ts:251-256`). Der Browser hat schon einmal gescrollt; der
Benutzer sieht eine zweite, verspätete Bewegung. Akzeptabel, und das
Policy-Modul ist gut getestet; niedrige Priorität. Konfidenz: mittel.

### 2.4 Bedienung jenseits des Scrollens, nach Rang

**U1. Der Terminal-Kopf ist eine Desktop-Werkzeugleiste.** Zurück, Titel,
Statuspunkt, Suche, Kopieren, A−, A+, Tasten: acht Elemente in einer Zeile
(`RemoteTerminal.tsx:1139-1208`), Buttons mindestens 40 px
(`terminal.css:108-111`), der Titel auf Ellipse in dem, was übrig bleibt
(`terminal.css:142-150`). Alles sitzt im oberen Streifen, dem Teil des
Schirms, den ein Daumen nicht erreicht; die seltenen Aktionen (Suche,
Kopieren, Schrift) nehmen den Platz, die häufigen (Tippen, Zurück) sitzen
in den Ecken.

**U2. Tippen ist hinter einem Schalter versteckt.** Auf kompaktem Chrome ist
die Eingabeleiste weg, bis die Tasten über den Schalter oben rechts geöffnet
werden (`terminal.css:592-604`, `RemoteTerminal.tsx:1194-1206`). Die Geste
"wie spreche ich mit diesem Agenten" ist nicht auffindbar.

**U3. Kein Positionsanzeiger in 5000 Zeilen.** Keine Scrollbar
(`terminal.css:318-325`), kein "Zeile N von M", nur zwei Pillen.

**U4. Kein Tap-Feedback auf dem am häufigsten getippten Control** (T7).

**U5. Der Übersichtskopf verbraucht seine Plätze für Desktop-Vorstellungen.**
Theme-Zyklus, Aktualisieren, Inbox-Pille (`App.tsx:629-661`). Aktualisieren
verdoppelt den Pull und das Aufwachen bei Sichtbarkeit; der Theme-Schalter
ist ein Settings-Eintrag.

**U6. Zurück sitzt in der installierten App nur oben links.** Der
History-Eintrag (`App.tsx:484-520`, `src/remoteClient/navState.ts:299-342`)
ist richtig, aber eine iOS-Home-Screen-App hat keine Kantenwisch-Geste,
sodass das `‹` bei `RemoteTerminal.tsx:1140-1148` der einzige Weg hinaus
ist.

**U7. Kartenköpfe sind dicht.** Name, Profil, Zähler, Attention-Punkt in
einem umbrechenden Button plus ein zweistufiges Stop (`App.tsx:1356-1415`);
auf einem Laptop in Ordnung, bei 390 px gedrängt. Niedrigste Priorität.

### 2.5 Komplexitätsbudget

Tragend und unverändert zu lassen: `useRemote.ts` (Leitung, Neuverbindung,
Resume-Tails, Befehlsqueue), `terminalAttach.ts` (append vs. replay),
`connection.ts`, `navState.ts` (Entwürfe, History-Eintrag, Speicher),
`viewModel.ts`, `inbox.ts`, `taskBoard.ts`, `i18n.ts`,
`themePreference.ts`, `sendKey.ts`, `haptics.ts`, `terminalBuffer.ts`
(Kopieren), `terminalFont.ts`.

Angesammelte Workarounds, die nur wegen des JS-Pans, des lokalen Fits und
des Viewport-Hinterherlaufens existieren, und die die Zielarchitektur
löscht:

| Mechanismus | Wo | Zeilen |
| --- | --- | --- |
| Gesten-Engine, Nachlauf, Teilzeilen-Split, Overscan, Compact-Chrome-Konstante | `terminalScroll.ts` und sein Test | 378 + 512 |
| Pan, Rad, Nachlauf, Fit, Resize, Viewport-Listener in der Komponente | `RemoteTerminal.tsx:499-563`, `:632-870`, `:949-953`, `:1010-1023` | etwa 450 |
| Host-Resize-Politik und Transient-Viewport-Heuristik | `terminalResize.ts` und sein Test | 116 + 104 |
| Pull-to-Refresh-Hook, Indikator, Textschlüssel | `usePullToRefresh.ts` und sein Test, `App.tsx:702-735`, `overview.css:136-161` | 548 + 409 + etwa 40 |
| Visual-Viewport-Verfolgung (zwei der drei veröffentlichten Variablen) | `useVisualViewport.ts`, `terminal.css:42-86`, `overview.css:77-85` | etwa 80 |
| Touch-Action-Leiter und Sprung-Padding | `terminal.css:26-40`, `:260-354`, `:418-427` | etwa 100 |
| Tests, die die gelöschten Mechanismen festnageln | `RemoteTerminal.test.ts:75-162`, `:182-241`, `:310-335` | etwa 180 |

Etwa 2.900 Zeilen fallen weg. Der Ersatz sind etwa 500 Zeilen, davon etwa
250 schlichtes `.ts` unter Test.

## 3. Zielarchitektur

### 3.1 Terminal: eine Leseransicht, kein Emulator auf dem Schirm

Den Scrollback als gewöhnlichen DOM-Text in einem nativen Scroller zeichnen.
Ein kopfloser xterm-Parser hält den Puffer; der Schirm zeigt Zeilen.

- **Parser.** `@xterm/headless` 5.5.0, derselbe Kern, den das Bundle schon
  ohne den Renderer mitliefert. Es kommt als devDependency neben
  `@xterm/xterm`, das das Handy dann nicht mehr importiert. Konstruiert wird
  es mit `cols` und `rows` des PTY aus dem Snapshot und nur dann in der Größe
  geändert, wenn ein späterer Snapshot eine andere Größe meldet. Der
  Leitungsweg bleibt genau wie er ist: `planAttach`, `trackWritten` und
  `attachScroll` (`terminalAttach.ts`) speisen `term.write`; `reset()` bei
  einem Replay; das Exit-Banner unverändert. Das Handy schickt nie einen
  `resize`-Frame, und `RemoteApi.resize` (`src/remoteClient/useRemote.ts:971`)
  fällt aus der Handy-API weg (der Protokolltyp bleibt).
- **Zeilen.** `term.buffer.active` wird abgelaufen. Zeilen unter `baseY`
  sind der Scrollback und unveränderlich (das Handy ändert nie die Größe,
  also kein Reflow), ihr DOM ist also append-only. Die `rows` Zeilen von
  `baseY` aufwärts sind die Live-Region und werden pro Write neu gezeichnet,
  auf einen Frame zusammengelegt, und ersetzen nur Zeilen, deren Run-Liste
  sich geändert hat. Scrollback-Trimmen am Kopf wirft dieselbe Zahl DOM-Zeilen
  ab. Jede Zeile ist ein `pre`-gestylter Block mit einem Textknoten im
  Normalfall und `<span>`-Läufen, wo sich Attribute ändern (aus der
  Zell-API: `getFgColorMode`, `getFgColor`, `getBgColor`, `isBold`, `isDim`,
  `isItalic`, `isUnderline`, `isInverse`, `getWidth`, `getChars`); Zellen
  der Breite 0 (Fortsetzung) werden übersprungen. Der Alternate-Buffer
  zeichnet genauso, ohne Scrollback. Der Live-Region-Renderer setzt den
  Cursor bei `cursorX`/`cursorY`.
- **Scroller.** `.reader { overflow-y: auto; overscroll-behavior: contain;
  touch-action: pan-y pinch-zoom; -webkit-overflow-scrolling: touch }` mit
  `user-select: text`. Zeilen umbrechen weich (`white-space: pre-wrap;
  overflow-wrap: anywhere`), sodass die 80 bis 200 Spalten des PTY auf einem
  390-px-Schirm lesbar sind; das ist der Punkt "Wrap statt horizontales
  Scrollen", den das Mobile-Dokument als Wunsch führt. Kein JavaScript fasst
  die Scroll-Position während einer Geste an. Folgen wird in einem passiven
  `scroll`-Listener aus `scrollHeight - scrollTop - clientHeight` gegen die
  Zeilenhöhe abgeleitet; beim Folgen und wenn Zeilen angehängt werden, gilt
  `scrollTop = scrollHeight` nach dem DOM-Patch. Sprung-zur-neuesten-Ausgabe
  bleibt als die eine Pille; die Sprung-zum-Anfang-Pille und die Nav-Zeile
  fallen weg, weil ein Fling den Anfang nativ erreicht.
- **Textfunktionen.** Native Long-Press-Auswahl ersetzt xterms Selection.
  Der Button zum Kopieren des ganzen Verlaufs behält
  `bufferPlainText(unwrapRows(...))` und `writeClipboard`
  (`RemoteTerminal.tsx:246-408`, `terminalBuffer.ts`). Suche wird eine
  schlichte Funktion über Zeilentexte plus eine Highlight-Klasse und ein
  `scrollIntoView` auf der Zeile, anstelle von `SearchAddon`.
- **Schriftgröße und Zoom.** A+ und A− setzen `font-size` auf dem Reader;
  nichts erreicht das PTY, nichts umbricht einen Puffer. Pinch-Zoom ist
  wirklich verfügbar, sobald das Overlay dem Visual Viewport nicht mehr
  hinterherläuft (3.3).
- **Eingabe.** Die Tastenzeile und der Composer bleiben die einzigen
  Tastaturquellen. `inputmode="none"` und die Regeln der xterm-Hilfs-Textarea
  fallen mit dem Renderer weg.

Was das ehrlich verliert: Maus-Reporting in eine TUI (ein Tap ist in den
Menüs von Claude Code kein Klick; der heutige Touch-zu-Maus-Pfad ist auf
dem Handy ohnehin unzuverlässig) und xterms eigene Such-Dekorationen. Was
es jenseits des Scrollens gewinnt: das PTY wird vom Handy nie in der Größe
geändert, TUI-Ausgabe wird auf dem Gitter gezeichnet, für das sie gemalt
wurde, Text ist auswählbar, dynamische Schriftgröße funktioniert, und das
Bundle lässt den DOM-Renderer und zwei Addons weg.

Bekannte Lücke, die zu entscheiden ist (siehe Abschnitt 6): die Größe des
PTY kann sich ändern, während das Handy angehängt ist, wenn das
Desktop-Fenster in der Größe geändert wird. Heute kündigt das keine
Server-Nachricht an; der nächste Snapshot beim erneuten Anhängen trägt sie.
Bis eine `size`-Server-Nachricht existiert, wird Ausgabe nach einem
Desktop-Resize in der alten Breite geparst, bis zur nächsten Neuverbindung.
Das ist eine seltenere Form des Zerhackens, das heute bei jedem Öffnen
passiert.

### 3.2 Verworfene Alternativen für das Terminal

**(a) Nativer Scroll auf `.xterm-viewport` mit `pan-y`.** Die Lehre des
Repos über Safari und `preventDefault` ist hier nicht das Hindernis: nichts
müsste irgendetwas abbrechen, und xterms eigene Touch-Handler lassen sich
mit `stopPropagation` in der Capture-Phase stilllegen, das Safari unabhängig
davon achtet. Das Hindernis ist T5. xterm schreibt `scrollTop` innerhalb
eines Frames jedes Scroll-Events auf eine Zeilengrenze zurück, sodass ein
nativer Pan um bis zu eine halbe Zeile ruckelt und ein Nachlauf-Scroll auf
jedem Frame gegen das Einschnappen kämpft. Es gibt keine öffentliche Option,
das abzuschalten. Verworfen.

**(a′) Ein eigener nativer Scroller mit xterm `position: sticky` darin,
angetrieben vom `scrollTop` des Wrappers** über `scrollToLine` plus die
bestehende Teilzeilen-Transformation. Das liefert native Gestenphysik,
Nachlauf, Gummiband und eine Scrollbar, bei etwa 150 Zeilen, und ist der
Fallback, wenn 3.1 abgelehnt wird. Aber das Paint bleibt JS-getrieben einen
Scroll-Event zu spät, der DOM-Renderer baut bei jedem Zeilenwechsel weiter
alle Zeilen neu (T6), das lokale-Gitter-Problem (T3) bleibt, es sei denn die
lokale Größe wird auf die des PTY festgenagelt, was xterm breiter macht als
das Handy, und Pinch und Selection bleiben wie sie sind. Als Ziel verworfen;
als Zwischenstufe nur akzeptabel, wenn 3.1 nicht geplant werden kann.

**(c) Den JS-Pan behalten und seine Mängel beheben**: das `has-jumps`-Fit
entfernen, auf Pinch nicht neu einpassen, die Overscan-Zeile beim Folgen
weglassen, Tap-Feedback hinzufügen. Jedes ist eine echte Korrektur, aber T1
ist eine Obergrenze, kein Mangel. Wenn der Compositor nicht pannen darf, ist
der beste Fall ein Hauptthread-Scroller, und die Safari-`pan-y`-Regel ist
genau das, was diese Alternative daran hindert, dem Browser die Geste je zu
gewähren. Als Richtung verworfen; die einzelnen Korrekturen stehen in WP0
als Notbehelf, falls WP1 sich verzögert.

### 3.3 Tastatur: dem Visual Viewport nicht hinterherlaufen

Das Terminal-Overlay wird `position: fixed; inset: 0` im Layout-Viewport und
verbraucht weder `--vv-height` noch `--vv-offset-top`. Auf Android Chrome
schrumpft `interactive-widget=resizes-content` den Layout-Viewport, das
Overlay schrumpft mit, der Reader gibt im Flex nach, und die Eingabeleiste bleibt ohne
JavaScript über den Tasten. Auf iOS schrumpft der Layout-Viewport nicht und
Safari verschiebt den Visual Viewport um die Tastaturhöhe, wenn der Composer
fokussiert ist; das Overlay bleibt stehen, sodass der Kopf oben hinaus
scrollt und die Eingabeleiste direkt über den Tasten sitzt, im selben Frame
wie die Tastatur, weil der Browser das getan hat. Das ist das native
Verhalten jeder Web-App mit fixem Layout auf iOS; der jetzige Code kämpft
dagegen (K1), und der Kampf ist das Schwimmen. Die Tastatur zu schließen
stellt den Kopf wieder her. Es gibt kein erneutes Einpassen, weil es kein
Fit gibt.

`useVisualViewport` veröffentlicht weiter `--keyboard-inset` für das untere
Padding der Übersicht (`styles.css:425`) und behält `revealFocus` für die
Felder der Übersicht; die Terminal-Hälfte von `revealPolicy` (das Urteil
`pinned`) bleibt als harmloser Wächter. `--vv-height` und `--vv-offset-top`
gehen zusammen mit ihren einzigen Verbrauchern (`terminal.css`,
`overview.css:77-85`) in den Ruhestand.

Verworfen: die Verfolgung behalten, aber auf ein `transform` legen (gleiche
Verzögerung, passt weiter neu ein); das Terminal zu einer Seite im
Dokumentfluss machen (gäbe denselben iOS-Shift umsonst, gibt aber das Design
der versteckten Übersicht und ihre Tests ohne weiteren Gewinn auf).

### 3.4 Übersicht: Dokument-Scroll behalten, was dagegen arbeitet entfernen

- Die Pull-to-Refresh-Geste löschen. Die Liste wird gepusht, `wake()` läuft
  bei Sichtbarkeit, `online` und `pageshow` (`useRemote.ts:895-921`), die
  Liveness-Sonde überführt eine tote Route, und das `⟳` im Kopf bleibt für
  ein bewusstes Aktualisieren. Wenn der Orchestrator die Geste zurück will,
  ist die einzige akzeptable Form: nur passive Listener, nie
  `preventDefault`, kein React-State pro Move, ein `position: fixed`-Indikator
  per `transform` bewegt, sodass die Dokumenthöhe sich nie ändert, und die
  Entscheidung auf `touchend`.
- Die Pulse nur auf dem Compositor (`transform` und `opacity` auf einem
  Pseudo-Element animieren statt `box-shadow`), und auf groben Zeigern eine
  solide Kopffläche statt `backdrop-filter`.
- Scroller, sticky Kopf, versteckte Übersicht und Scroll-Lock genau so
  lassen, wie sie sind.

## 4. Umsetzungsplan

Unabhängige Pakete. WP1 und WP2 teilen sich `terminal.css` und sollten
zusammen ausgeliefert werden. Tests: vitest läuft in Node ohne DOM, deshalb
wandert jede Entscheidung in ein schlichtes `.ts`-Modul, und das `.tsx` wird
durch Quelltext-lesende Tests im Stil von `RemoteTerminal.test.ts` geprüft.

### WP1: Terminal-Reader

Dateien:

- Neu `src/remoteClient/terminalRows.ts` (rein): `rowRuns(line, cols)`
  liefert Läufe von `{ text, fg, bg, bold, dim, italic, underline, inverse }`
  aus einem minimalen Zell-Reader-Interface; `liveRange(buffer)` liefert
  `[baseY, baseY + rows)`; `followState({ scrollTop, scrollHeight,
  clientHeight, rowHeight })`; `findRow(rows, query, from, direction)`;
  `trimHead(prevLength, nextLength, baseY)` für Scrollback-Trimmen. Tests
  in `terminalRows.test.ts` mit Fake-Zeilen zu Attribut-Läufen, breiten und
  nullbreiten Zellen, umbrochenen Zeilen, Kopf-Trimmen, der Folgen-Schwelle
  und Such-Wrap-around.
- Neu `src/remoteClient/TerminalReader.tsx`: konstruiert das kopflose
  Terminal aus `cols` und `rows` des Snapshots, besitzt das append-only
  Scrollback-DOM und den Live-Region-Patch (auf einen Frame zusammengelegt
  über `onWriteParsed` oder den `write`-Callback), den nativen Scroller,
  das Folgen, die Cursor-Glyphe, Suche, Schriftgröße und Kopieren.
- `RemoteTerminal.tsx` schrumpft auf Chrome: Kopf, Tastenzeile,
  Eingabeleiste, Exit-Zustand, `<TerminalReader>`. Den Pan-, Rad-, Nachlauf-,
  Fit- und Resize-Code und die `ResizeObserver`- und `visualViewport`-Listener
  löschen; `terminalScroll.ts`, `terminalResize.ts` und ihre Tests löschen;
  `resize` aus `RemoteApi` entfernen.
- `terminal.css`: die Regeln für `.terminal-stage`, `.terminal-host` und
  xterm durch `.reader`, `.row`, die 16-Farben-Palettenklassen auf die
  Brand-Tokens gemappt, und die Sprung-zur-neuesten-Pille ersetzen; die
  Nav-Zeile, die Sprung-zum-Anfang-Pille und das `has-jumps`-Padding löschen.
- `package.json`: `@xterm/headless` hinzufügen. `@xterm/xterm`, `addon-fit`
  und `addon-search` bleiben, weil das Desktop-Terminal
  (`src/renderer/src/terminal/TerminalApp.tsx`) alle drei nutzt; nur das
  Handy-Bundle importiert sie nicht mehr.
- `RemoteTerminal.test.ts`: die Blöcke bei `:75-162`, `:182-241` und
  `:310-335` löschen; hinzufügen: die Komponente ruft nie `resize` auf der
  API auf; das kopflose Terminal wird aus Snapshot-`cols` und `-rows`
  konstruiert; `.reader` erklärt `touch-action: pan-y` und
  `overscroll-behavior: contain`; kein `touchmove`-Listener existiert in den
  Terminal-Quellen.

Abnahme, auf einem iPhone (Safari) und einem Android-Handy (Chrome) über
Tailscale:

1. Ein Flick über den Verlauf bremst mit der Plattformkurve, zeigt die
   native Scrollbar und macht an beiden Enden Gummiband; ein langsamer Drag
   bewegt 1:1.
2. Long-Press wählt Text aus und das Callout kopiert ihn.
3. Ausgabe, die bei Pause ankommt, bewegt die Ansicht nicht;
   Sprung-zur-neuesten-Ausgabe kehrt zurück und folgt wieder; eine
   Neuverbindung bei Pause hängt an und hält.
4. Eine Claude-Code-Sitzung zeichnet ihre Ink-Oberfläche ohne doppelte oder
   zerrissene Zeilen, weich umbrochen an der Spaltenzahl des Desktops.
5. A+, A−, die Tasten öffnen, den Composer fokussieren und das Handy drehen
   schicken keinen `resize`-Frame (prüfen mit einem loggenden `sendRaw` in
   Dev, oder am Gateway-Log).
6. Das Desktop-Terminal zeichnet nie neu wegen einer Handy-Aktion.

**Status: umgesetzt** auf diesem Branch, mit diesen Abweichungen vom Plan
oben.

- `isCompactChrome` und `COMPACT_MAX_WIDTH_PX` wanderten aus dem gelöschten
  `terminalScroll.ts` in ein neues `terminalChrome.ts` (mit Test); der
  Chrome-Fold braucht sie weiter.
- `@xterm/xterm`, `addon-fit` und `addon-search` bleiben in `package.json`
  für das Desktop-Terminal; das Handy-Bundle importiert keines davon. Der
  Terminal-Chunk trägt stattdessen `@xterm/headless` und misst 43 kB gzippt;
  der Entry-Chunk misst 67 kB gegen das 72-kB-Budget.
- Der Reader behält zwei passive Listener, `touchstart` und `touchend`, die
  nur merken, ob ein Finger unten ist: der Follow-Snap nach einem
  Ausgabe-Burst wartet, solange das der Fall ist. Es gibt keinen
  `touchmove`-Listener und kein `preventDefault` irgendwo im Reader.
- Ein pausierter Reader behält Kopfzeilen, die der Puffer schon getrimmt hat
  (bis 5000), statt `scrollTop` zu kompensieren, sodass JavaScript die
  Scroll-Position an genau einer Stelle schreibt; die veralteten Zeilen
  fallen beim nächsten Folgen weg.
- Die Sprung-zum-Anfang-Pille, die Nav-Zeile und ihre fünf Textschlüssel
  (`toTop`, `toBottom`, `pageUp`, `pageDown`, `historyControls`) sind in
  beiden Locales weg. Das `has-jumps`-Host-Padding ist mit ihnen weg; der
  Reader hat ein dauerhaftes unteres Padding, über dem die
  Sprung-zur-neuesten-Pille schwebt.
- Suche hebt die Trefferzeile hervor und zentriert sie mit `scrollTo` auf
  dem Reader, ein vom Benutzer angefordertes Scrollen wie
  Sprung-zur-neuesten-Ausgabe.
- `RemoteApi.resize` ist aus der Handy-API entfernt; der Leitungstyp bleibt,
  und der Server akzeptiert den Frame weiter von älteren Clients.
- Die Compact-Regeln des Chrome (Eingabeleiste weg, bis die Tasten öffnen)
  sind unverändert; WP4 besitzt sie.

Abnahme, hier geprüft: Punkte 5 und 6 gelten konstruktionsbedingt und sind
durch `RemoteTerminal.test.ts` festgenagelt (kein `resize` zum Senden, kein
Fit zum Laufen); das Zeichnen der Zeilen, die Scrollback-Buchhaltung, das
Folgen und die Suche deckt `terminalRows.test.ts`; Bau und Bundle-Wächter
laufen durch. Punkte 1 bis 4 (natives Gefühl des Pans, Long-Press-Auswahl,
Halten bei Pause, Ink-Zeichnung in der Spaltenzahl des Desktops) brauchen
ein Handy und bleiben auf dem Gerät zu prüfen.

### WP2: Tastatur, fixes Overlay, kein Hinterherlaufen

Dateien: `terminal.css` (`.terminal-view { inset: 0 }`, kein `var(--vv-`),
`overview.css:77-85` (dasselbe für `.terminal-pending`),
`useVisualViewport.ts` (`--vv-height` und `--vv-offset-top` nicht mehr
veröffentlichen, `--keyboard-inset` und `revealFocus` behalten, den
Docblock-Vertrag aktualisieren), `styles.css:127-129` (die zwei Fallbacks
streichen). Tests: `revealPolicy.test.ts` unverändert; einen
Quelltext-lesenden CSS-Test hinzufügen, dass `.terminal-view` `inset: 0`
enthält und dass kein Sheet `--vv-height` oder `--vv-offset-top`
referenziert.

Abnahme: den Terminal-Composer auf iOS zu fokussieren setzt die
Eingabeleiste direkt über die Tastatur in denselben Frame, in dem die
Tastatur fertig ist, ohne Frame-für-Frame-Bewegung des Terminals; auf
Android schrumpft der Reader und die Leiste bleibt über den Tasten; die
Tastatur zu schließen stellt den Kopf wieder her; in keinem der beiden Fälle
ist ein Puffer-Reflow sichtbar.

**Status: umgesetzt** auf diesem Branch. `.terminal-view` und
`.terminal-pending` sind `inset: 0`; `useVisualViewport.ts` veröffentlicht
nur `--keyboard-inset` und behält `revealFocus`; `styles.css` behält den
einen Fallback. Kein Sheet und kein Modul referenziert die zwei
zurückgezogenen Variablen, und `RemoteTerminal.test.ts` nagelt das fest. Das
Tastaturverhalten selbst (Eingabeleiste über den Tasten im selben Frame,
kein Schwimmen, kein Reflow) bleibt auf dem Gerät zu prüfen.

### WP3: Übersicht, Pull löschen, Paint beruhigen

Dateien: `usePullToRefresh.ts` und seinen Test löschen; `App.tsx:702-735`
(der Hook-Aufruf und der Indikator); `overview.css:136-161`; in `i18n.ts`
`pullToRefresh`, `releaseToRefresh`, `refreshing` und `pullNoAnswer` in
beiden Locales entfernen (der i18n-Test bei `i18n.test.ts:135-181` fällt
auf einen unreferenzierten Schlüssel, die Schlüssel müssen also mit dem
Schirm weg); `overview.css:505-519`, `:362-368` und `styles.css:295-316`
(Pulse auf einem Pseudo-Element mit `transform` und `opacity`);
`styles.css:441-460` (solide Fläche unter `(pointer: coarse)`). Tests:
`i18n.test.ts` erzwingt den Text; einen Quelltext-lesenden CSS-Test
hinzufügen, dass kein Keyframe `box-shadow` animiert.

Abnahme: ein Flick von `scrollY = 0` auf iOS bewegt die Liste einmal, nur
mit dem nativen Gummiband; kein React-Commit während einer Scroll-Geste
(prüfen mit dem React-Profiler in Dev); zehn arbeitende Agenten verlieren
während eines Scrolls auf einem mittleren Android-Handy keine Frames.

**Status: umgesetzt** auf diesem Branch als der in 3.4 beschriebene Neubau,
nicht als Löschung.

- `usePullToRefresh.ts` bleibt. Jeder Window-Listener ist für seine
  Lebenszeit `{ passive: true }`; der Indikator ist `position: fixed` und
  wird mit `transform` / `opacity` über CSS-Custom-Properties am Element
  bewegt (`--pull-shown`, `--pull-opacity`), nicht per React-State pro Move.
  Die Aktualisierungsentscheidung fällt auf `touchend`. React-Phasen-State
  ändert sich nur an Gestengrenzen (Claim, Arm, Release, Refreshing, Done).
  Die vier Textschlüssel bleiben in beiden Locales.
- Gesten-Zugehörigkeit ist ein `closest()` gegen `PULL_REFUSE_SELECTOR`,
  nicht der `getComputedStyle`-Vorfahrenlauf aus O2.
- Pulse (`vg-pulse`) animieren `transform` und `opacity` auf einem
  Pseudo-Element. Kein Keyframe in den drei Sheets animiert `box-shadow`.
- `.app-header` und `.to-top` nutzen eine solide `--surface` und
  `backdrop-filter: none` unter `(pointer: coarse)`.

Abnahme, hier geprüft: der passive Window-`touchmove`, der fixe Indikator,
der keine Layout-Höhe einschiebt, compositor-only Keyframes und der solide
Kopf auf grobem Zeiger sind durch `overviewPaint.test.ts` festgenagelt; die
Distanzkurve, die Intent-Sperre, die Phasenmaschine und das Urteil deckt
`usePullToRefresh.test.ts`; `i18n.test.ts` verlangt weiter die vier
Pull-Schlüssel. Das iOS-Gummiband beim Flick vom Anfang, „kein React-Commit
während einer Scroll-Geste“ und das Frame-Budget mit zehn arbeitenden
Agenten brauchen ein Handy und bleiben auf dem Gerät zu prüfen.

### WP4: Terminal-Chrome für den Daumen

Dateien: `RemoteTerminal.tsx` (Kopf reduziert auf Zurück, Titel, Statuspunkt
und ein Overflow-Menü mit Suche, Kopieren und dem Schriftpaar; eine
permanente untere Leiste auf kompaktem Chrome mit Tasten-Schalter, Eingabe
und Senden, die Eingabe nie versteckt), `terminal.css` (`.terminal-bar` auf
`--touch`-Höhe mit `env(safe-area-inset-bottom)`), `overview.css`
(`.agent-row:active`), `App.tsx:457` (der Pending-Zustand zeigt den
Terminal-Kopf mit dem Namen des Agenten und einer "connecting"-Notiz statt
einer leeren Box), `i18n.ts` (neue Schlüssel in beiden Locales). Tests:
`i18n.test.ts`; ein Quelltext-lesender Test, dass die Eingabeleiste auf
kompaktem Chrome nicht versteckt ist.

Abnahme: der Composer ist mit einem Daumen erreichbar, ohne den oberen
Schirmrand zu berühren; ein Tap auf eine Agentenzeile blitzt und zeigt
innerhalb eines Frames einen benannten, nicht leeren Schirm.

**Status: umgesetzt** auf diesem Branch.

- Der Kopf ist Zurück, Titel, Statuspunkt und ein Overflow-Menü
  (`copy.terminalMenu`) mit Suche, Kopieren und dem Schriftpaar. Das Menü
  schließt bei einem Tipp außerhalb und bei Escape; es ist keine Focus-Trap.
- Die Eingabeleiste ist eine permanente `.terminal-bar` auf `--touch`-Höhe
  mit `env(safe-area-inset-bottom)`: Tasten-Schalter, Feld und Senden.
  Kompaktes Chrome versteckt `.input-bar` nicht mehr.
- `.agent-row:active` skaliert die Zeile (`transform: scale(0.97)`), und die
  Zeile nimmt das Tap-Highlight wieder an.
- Ein Terminal zu öffnen zeichnet `TerminalPending` im selben Frame wie den
  Tipp (es lebt in `App.tsx`, nicht im Terminal-Chunk): Zurück, den
  Agentennamen und `copy.terminalConnecting`.

Abnahme, hier geprüft: die Kopf-Zusammensetzung, die nicht versteckte
kompakte Eingabeleiste, `.agent-row:active` und der benannte Pending-Schirm
sind durch `RemoteTerminal.test.ts` und `App.test.ts` festgenagelt; die
neuen Schlüssel (`terminalMenu`, `terminalConnecting`) verlangt
`i18n.test.ts` in beiden Locales. Die Daumen-Erreichbarkeit des Composers
und „benannter Schirm innerhalb eines Frames“ über Tailscale brauchen ein
Handy und bleiben auf dem Gerät zu prüfen.

### WP5: Übersichtskopf und Kartendichte (zurückgestellt)

Den Theme-Schalter aus dem Kopf nehmen (ein Menü oder der Kopplungs-Schirm),
`⟳` und die Inbox-Pille behalten, den Kartenkopf auf Name und Status
reduzieren, das Profil in den Rumpf. Kein Scroll-Effekt; nach WP1 bis WP4
planen.

### WP0: Notbehelf nur, wenn WP1 nicht als Nächstes kommt

Das nicht tun, wenn WP1 in derselben Iteration startet; es würde gelöscht.
Sonst: die Sprung-Pillen über dem Host schweben lassen ohne Padding
(`terminal.css:269-271`), sodass `has-jumps` den `ResizeObserver` nicht mehr
auslöst; `visualViewport`-`resize` beim Einpassen ignorieren, wenn
`isTransientViewport` wahr ist; die Overscan-Zeile nur anwenden, wenn nicht
gefolgt wird; `.agent-row:active` hinzufügen. Jedes ist eine
Zwei-Zeilen-Änderung, und keines hebt die Obergrenze in T1.

## 5. Was bleiben muss

- Das Dokument ist der Scroller der Übersicht: `html { overflow-y: auto }`,
  kein Overflow auf `body`, kein inneres Overflow auf der Liste, sticky Kopf
  (`styles.css:183-215`, `overview.css:164-173`).
- Jeder `touchmove`-Listener auf Window-Ebene bleibt `{ passive: true }` für
  seine Lebenszeit (`usePullToRefresh.ts:22-31`). WP3 hat den Pull in dieser
  Form neu gebaut; `overviewPaint.test.ts` nagelt die Registrierung fest.
- Die Übersicht ist unter dem Terminal versteckt, nicht abgehängt, und bleibt
  gelegt (`App.tsx:421-428`, `overview.css:42-58`, `useDocumentScrollLock`).
- Ein History-Eintrag pro offenem Terminal, ohne URL geschoben, geschlossen
  durch Hardware-Zurück (`App.tsx:484-520`, `navState.ts:299-342`).
- Die sechs Befehlsverben (`src/shared/remote/protocol.ts:28-44`). WP1
  entfernt einen vom Handy ausgelösten Frame (`resize`) und fügt nichts
  hinzu. Eine künftige `size`-Nachricht Server-zu-Client (die bekannte Lücke
  in 3.1) ist kein Befehl und weitet die Allow-List nicht, ist aber eine
  Protokolländerung und braucht die Entscheidung des Orchestrators.
- Kein zod im Handy-Bundle (Commit `09d4833`): `@xterm/headless` zieht keins;
  `questionChoicesDisplay` auf seinem zod-freien Pfad lassen.
- Neuverbindung und Resume unverändert: `terminalAttach.ts`, die
  Resume-Tails in `useRemote.ts`, `REMOTE_COALESCE_MS` auf der Bridge. Der
  Reader verbraucht dieselben `onSnapshot`-, `onData`- und `onExit`-Handler.
- 44-px-Touch-Ziele (`--touch`), 16 px Mindestschrift der Eingabe, beide
  Locales für jeden Textschlüssel, und die CSP in `index.html` (alles
  gebündelt, kein externes Skript).
- Die Unterscheidung `hide` versus `minimize` und die Presets-Matrix sind
  Desktop-Anliegen und werden von keinem Paket hier angefasst.

## 6. Fragen an den Orchestrator

1. Muss das Handy in einer TUI klicken können (Maus-Reporting)? Annahme:
   nein.
   **Entschieden: kein Maus-Reporting.**
2. Darf WP1 eine `size`-Nachricht Server-zu-Client hinzufügen, sodass ein
   Desktop-Resize ein angehängtes Handy erreicht, oder ist "in der alten
   Breite geparst bis zur nächsten Neuverbindung" für den ersten Schnitt
   akzeptabel? Annahme: für den ersten Schnitt akzeptabel.
   **Entschieden: keine `size`-Nachricht in diesem Schnitt.** Der Reader
   ändert seinen Parser nur, wenn ein Snapshot eine andere Größe nennt.
3. Pull-to-Refresh ganz löschen (empfohlen) oder in der passiven Form mit
   fixem Indikator aus 3.4 neu bauen?
   **Entschieden: passiv neu gebaut, nicht gelöscht.** WP3 hat diese Form
   ausgeliefert.
4. Ist `@xterm/headless` eine akzeptable neue devDependency? Wenn nicht,
   parst das nicht geöffnete `Terminal` aus `@xterm/xterm` ohne `open()`, zum
   Preis, den Renderer mitzuschicken, den der Reader nie benutzt.
   **Entschieden: `@xterm/headless` akzeptiert.** Das Handy-Bundle importiert
   es; `@xterm/xterm` bleibt für das Desktop-Terminal.
