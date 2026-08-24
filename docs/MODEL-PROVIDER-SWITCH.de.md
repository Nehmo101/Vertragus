Deutsch | [English](MODEL-PROVIDER-SWITCH.md)

# Modell- und Provider-Wechsel mitten im Lauf (Reseat)

Plan, um **Modell, Provider oder Effort-Level eines laufenden Agenten** zu
wechseln — Root-Orchestrator wie Worker — ohne den Lauf wegzuwerfen.

**Status:** nur Spec. Nichts davon ist in der Runtime. Die Orchestrator-Hälfte
ist eine kleine Erweiterung der C6-Succession (als S1 bereits im Code); die
Worker-Hälfte ist ein neues Tool ohne Vorläufer.

**Nicht dieses Feature:**

| Verwechslung | Was es tatsächlich ist |
| --- | --- |
| Provider/Modell-Felder im Profil-Editor | Konfiguration für das *nächste* Play, nicht für den laufenden Run |
| `start_agent{providerId, model}` | Wahl bei der Geburt, begrenzt durch die Profil-Slots |
| C4 `start_agent{baseBranch}` | Ein *anderer* Agent macht auf einem Branch weiter — neuer Sitz, nicht derselbe |
| C6 Succession | Dieselbe Feature-Familie, aber der Sitz behält heute den Provider des Profils |
| Phase F `start_orchestrator{model}` | Ein verschachtelter Lead, einmal gestartet, nie neu besetzt |
| `stop_agent` + `start_agent` | Der heutige Workaround — und er verliert stillschweigend Arbeit (siehe §3.2) |

**Ein-Satz-Urteil:** Ein laufendes CLI kann seinen Provider nicht wechseln —
ein Wechsel ist also entweder ein provider-deklariertes In-Session-Kommando
(nur Modell, gleicher Provider) oder ein **Reseat**: derselbe Sitz (Rolle,
Slot, Worktree, Branch, Queue, offene Fragen), neuer Prozess, Kontext über ein
host-gebautes Paket hinüber.

---

## 1. Problem

Provider und Modell sind **Launch-Zeit-argv**. `spawnAgent` setzt das
Executable (`provider.command`), das Modell (`modelArg`, bei Ollama
positional), das Effort-Flag, den MCP-Attach-Dialekt und die
System-Prompt-Delivery genau einmal zusammen, beim Spawn. Nichts davon lässt
sich in einem lebenden PTY-Prozess umbiegen.

Jeder echte Grund für einen Wechsel kommt aber *mitten im Lauf*:

- Das Rate-Limit oder Kontingent-Fenster des Providers schließt. Das CLI läuft
  weiter und hört auf, nützlich zu sein — oder stirbt.
- Das Modell passt nicht zur Phase: billig und schnell für die Sichtung, stark
  für das heikle Refactoring, wieder billig für den mechanischen Rest.
- Ein Provider ist an derselben Aufgabe zweimal gescheitert, und die zweite
  Meinung ist der ganze Sinn davon, sechs davon zu haben.
- Der Mensch sieht ein Terminal und weiß es besser als der Lauf.

Heute lauten die Antworten: Workspace neu starten (Lauf weg), oder
`stop_agent` + `start_agent` (was das kostet, steht in §3.2), oder für den Root
schlicht gar nichts.

---

## 2. Zwei Mechanismen, ein Feature

### 2.1 In-Session-Modellwechsel (gleicher Prozess)

Manche CLIs nehmen ein Slash-Kommando, das das Modell innerhalb der laufenden
Session tauscht (`/model …`). Der Kontext bleibt vollständig erhalten, und der
Wechsel kostet nichts.

Seine Grenzen sind hart: Er kann den **Provider** nie wechseln (das ist ein
anderes Executable), er ist heute in `ProviderConfig` nirgends deklariert, und
Tippen in ein PTY mitten im Turn wird verschluckt oder zerhackt. Für den Root
ist es noch schlimmer — Tippen ins Orchestrator-TUI, während `await_events`
parkt, startet einen zweiten Turn in einem Prozess, der bereits die Schleife
fährt: genau der Zwei-Gehirne-Fehler, den das Handbuch unter H1 benennt.

Dieser Pfad ist also eine **Optimierung**, gegated auf: Provider deklariert es,
gleicher Provider, Agent ist idle, Host misst die Annahme. Niemals der
Mechanismus, auf dem ein Provider-Wechsel ruht. Details in §7.

### 2.2 Reseat (neuer Prozess, übertragener Kontext)

Der allgemeine Mechanismus. CLI töten, den **Sitz** behalten — alles, was
Host-Zustand ist statt Modell-Zustand — und ein neues CLI darin starten, mit
einem Paket, das sagt, was bisher geschah.

Was „der Sitz“ je nach Art bedeutet:

| Sitz-Eigenschaft | Orchestrator | Worker |
| --- | --- | --- |
| Identität im Roster | neue `agentId` (so entschied C6) | **gleiche `agentId`** (siehe §4) |
| Worktree / Branch | neuer Orch-Worktree | **gleicher Worktree, gleicher Branch** |
| Event-Queue | dieselbe Instanz | dieselbe Instanz |
| Offene Fragen | dieselbe Registry | dieselbe Registry, **nicht gecancelt** |
| Slot-Reservierung | keine | über die Lücke gehalten |
| MCP-Token | `orchToken` rotiert | Per-Agent-Subtoken rotiert |
| Kontext-Transfer | Succession-Paket (`handoff.ts`) | Worker-Paket (C4-Block, host-angereichert) |

Beide Hälften sind auf dieselbe Weise verlustbehaftet: Der neue Prozess bekommt
ein strukturiertes Briefing, nicht das Transkript des Vorgängers. Das ist der
Preis — und der Grund, warum ein Reseat eine *Entscheidung* ist und nichts, was
der Host von sich aus tut.

---

## 3. Was der Code heute tut

### 3.1 Der Orchestrator-Sitz

Die C6-Succession führt bereits eine vollständige Sitzübergabe durch:
`requestSuccession` friert ein Paket ein (`buildSuccessionPackage`),
persistiert es, rotiert `orchToken`, spawnt und seedet den Nachfolger und
tötet dann das PTY des Vorgängers — durchgehend mit derselben `EventQueue`,
derselben `PendingQuestions` und denselben Subagenten.
`replaceOrchestratorFromHost()` ist derselbe Pfad vom Host aus und akzeptiert
einen toten Vorgänger.

Das Einzige, was es nicht kann, ist das Gehirn des Sitzes wechseln:
`spawnOrchestratorRecord` liest `this.profile.orchestrator.providerId` und
`this.profile.orchestrator.model` direkt. Ein Nachfolger ist damit immer
dasselbe Modell wie der Amtsinhaber, dem der Kontext ausging — oder das
Kontingent.

Damit ist die Orchestrator-Hälfte dieses Features **ein Parameter plus ein
Preflight**, kein neuer Mechanismus.

### 3.2 Der Worker-Sitz

Es gibt kein Reseat. Das Nächstliegende ist `stop_agent{agentId}` gefolgt von
`start_agent{role, providerId?, model?, baseBranch: <der Branch>}`. Das
funktioniert — C3 und C4 machen Branch und Handoff-Block echt —, aber es ist
nicht derselbe Sitz, und vier Dinge gehen verloren:

1. **Nicht committete Arbeit.** `stopAgent` geht direkt in `terminate`, und
   das tötet das PTY. Nur `snapshotDone` committet einen schmutzigen Worktree,
   und es läuft bei `agent_done`. Einen Worker mitten in der Aufgabe zu
   stoppen wirft also alles weg, was er nicht committet hat — und die
   Rollen-Prompts sagen Workern ausdrücklich, *nicht* zu committen. Das ist
   die schärfste Kante des heutigen Workarounds.
2. **Die offene Frage.** `terminate` ruft `questions.cancelForAgent`. Ein
   Worker, der in `ask_orchestrator` parkt, verliert dabei seinen Waiter.
3. **Identität.** Neue `agentId`, neuer Name (`names.release`), neues Fenster.
   Der `ownerAgentId` des Task-Boards, jede Notiz, die der Orchestrator zu
   diesem Agenten geschrieben hat, und jedes Event, das schon in der Queue
   liegt, zeigen jetzt auf eine Leiche.
4. **Der Provider ist nicht frei.** `beginAgent` löst den Slot über
   `slotWithCapacity(role, {providerId})` auf, und das ist ein **harter
   Fehler**, wenn kein Slot dieser Rolle den gewünschten Provider fährt. Einen
   Reviewer von Codex auf Claude zu bewegen ist unmöglich, sofern das Profil
   nicht zufällig einen Claude-Reviewer-Slot deklariert. Der Stop gibt den Slot
   außerdem frei, sodass ein paralleles `start_agent` ihn vor dem Ersatz nimmt.

Der Aufgabentext steht überhaupt nicht auf `AgentRecord`, also muss selbst ein
perfekter Aufrufer die Aufgabe wortgleich behalten und neu senden.

---

## 4. Design-Entscheidungen (Defaults)

| Entscheidung | Default | Warum |
| --- | --- | --- |
| Mechanismus | Reseat zuerst; In-Session-`/model` später und optional | Nur das Reseat kann den Provider wechseln; es darf nicht am fragilen Pfad hängen |
| Orchestrator-Oberfläche | `request_succession{successor:{providerId?, model?, effort?}}` | Zustandsmaschine, Fencing und Paket existieren — keinen zweiten Cutover bauen |
| Worker-Oberfläche | Neues Tool `reseat_agent{agentId, providerId?, model?, effort?, reason?, note?}` | `stop_agent` + `start_agent` kann „derselbe Sitz“ nicht ausdrücken |
| Worker-`agentId` | **Unverändert**; ein `generation`-Zähler steigt | Die Identität eines Workers ist sein Branch und seine Aufgabe, nicht sein Prozess (der Root entschied für sein Fenster bewusst umgekehrt) |
| Worker-Worktree/Branch | **Wiederverwendet** | Die angefangene Arbeit *ist* die Übergabe; ein frischer Branch bräuchte einen Merge, um dasselbe zu sagen |
| Nicht committete Arbeit | **Host snapshot-committet vor dem Kill** | Derselbe Commit-Pfad wie C3 (`commitWorktree`), damit die SHA im Paket stimmt |
| Slot | Über die Lücke **gehalten** | Freigeben lädt zum Wettlauf um genau den Sitz ein, den das Reseat besetzen will |
| Slot vs. Provider | Ein Reseat **darf die Profil-Slots verlassen** | Sonst hängt ein Provider-Wechsel daran, dass das Profil ihn vorher erraten hat. Die *Kapazität* des Slots bindet weiter, sein Provider nicht |
| Offene Fragen | **Bleiben**; der Nachfolger erfährt davon | Ein verwaister MCP-Waiter ist schlimmer als eine verzögerte Antwort (C6 hat das schon so entschieden) |
| Preflight | Health + Auth + Modell-Liste **bevor** irgendetwas getötet oder rotiert wird | Ein falscher Modellstring muss als Absage scheitern, nicht als Lauf ohne Fahrer |
| Persistenz | Run-lokal; das Profil wird **nicht** umgeschrieben | Das Profil ist die Konfiguration des Nutzers; ein Wechsel ist eine Tatsache über diesen Lauf. Die `meta.json` des Runs trägt ihn, damit E3-Resume den Sitz startet, der wirklich lief |
| Host-Autonomie | Der Host wechselt **nie** von selbst | Dieselbe Regel, die C5 vom Spawnen abhält: erkennen, melden, Orchestrator oder Mensch entscheiden lassen |
| Effort | Fährt mit Modell und Provider mit | `EFFORT_LEVELS` ist bereits provider-agnostisch; ein Provider ohne `effortArg` lässt es fallen |

---

## 5. Orchestrator-Reseat — C6 plus ein Feld

### 5.1 Tool-Oberfläche

```
request_succession{
  reason: "context_full" | "long_run" | "user_requested"
        | "provider_limit" | "provider_switch" | "other",
  successor?: { providerId?: string, model?: string, effort?: "low"|"medium"|"high" },
  goal?, decisions?, risks?, nextActions?, agentNotes?, note?   // unverändert
}
```

Zwei neue Gründe, weil „mein Provider bedient mich nicht mehr“ und „ich will
ein stärkeres Modell für den Endspurt“ kein `other` sind — Panel, Journal und
Retro lesen dieses Feld.

Host-Seite: `SuccessionRequest` trägt das Override, der Succession-Zustand hält
es, und `spawnOrchestratorRecord` bekommt ein `seat`-Argument, statt das Profil
zu lesen. Das Paket hält beide Enden fest (`predecessor{providerId, model}`
existiert; `successor{…}` kommt dazu), damit der Seed des Nachfolgers sagt,
welches Gehirn er ersetzt hat.

`replaceOrchestratorFromHost({providerId?, model?, effort?})` ist dasselbe
Override vom Panel — und weil es einen toten Vorgänger akzeptiert, ist es die
Antwort auf „Claude ist ins Limit gelaufen und der Orchestrator ist gestorben“:
anderen Provider wählen, Team behalten, Queue behalten.

### 5.2 Preflight vor dem Cutover

Die Cutover-Reihenfolge in C6 lautet: Token rotieren, Nachfolger spawnen,
Vorgänger töten. Diese Reihenfolge stimmt, solange der Nachfolger dasselbe CLI
ist, das gerade noch lief. Mit einem Override hört ein Spawn-Fehler auf, ein
Ausnahmefall zu sein — ein vertippter Modellname ist jetzt der *wahrscheinliche*
Fehler —, und bis dahin ist das Token des Amtsinhabers schon tot.

Ein Reseat validiert deshalb, bevor es `PREPARING` betritt:

1. Provider existiert in der Registry und kann den Root-Sitz halten (§5.3).
2. Die Versionsprobe aus `health.ts` antwortet innerhalb von
   `HEALTH_TIMEOUT_MS`.
3. `authStatus.ts` ist nicht `logged-out` (`unknown` passiert, mit dem Zustand
   im Event — die Hälfte der CLIs kann ehrlich nichts sagen, und raten ist
   schlimmer).
4. Das Modell taucht in der Liste aus `discovery.ts` für diesen Provider auf,
   sofern der Provider eine ermittelbare Liste hat. Eine unbekannte Liste ist
   eine Warnung, nie eine Absage — fest verdrahtete Kataloge sind ein
   Handbuch-Non-Goal.

Fällt 1–3 durch, weist der Tool-Call mit Grund ab. Nichts ist eingefroren, kein
Token rotiert, der Amtsinhaber fährt weiter.

### 5.3 Was der Ziel-Provider können muss

Der Root fährt die Schleife über MCP. Ein Provider mit `mcp: {kind: 'none'}` —
heute Ollama — **kann den Orchestrator-Sitz nicht halten**, und ein Reseat
dorthin muss abweisen statt einen stummen Root zu erzeugen. Das ist einen
Guard-Test wert: Es ist eine Invariante über Deskriptoren, und Deskriptoren
sind nutzer-editierbar.

`systemPromptDelivery: {kind: 'pty'}` (Cursor, Ollama) ist erlaubt, aber teuer:
Das ganze Succession-Paket geht als getippter Text durch den Seed-Handshake.
Der Paket-Cap (`PACKAGE_MAX_CHARS`, 48k) ist für ein Launch-Flag bemessen, nicht
für ein TUI-Paste. Ein PTY-belieferter Nachfolger bekommt einen engeren Cap, und
der bestehende gemessene Handshake entscheidet, ob es geklappt hat —
`interactiveReady` weist einen nicht angenommenen Seed bereits ab.

---

## 6. Worker-Reseat — `reseat_agent`

### 6.1 Tool-Oberfläche

```
reseat_agent{
  agentId: string,
  providerId?: string,
  model?: string,
  effort?: "low" | "medium" | "high",
  reason?: "provider_limit" | "stuck" | "second_opinion" | "cost" | "user_requested" | "other",
  note?: string          // eine Zeile für den Nachfolger, gecappt wie eine orchNote
}
```

Asynchron wie `start_agent`: liefert schnell `{state: "reseating", agentId,
generation}`, das Ergebnis trägt die Queue. Mindestens eines von `providerId`,
`model`, `effort` muss sich von dem unterscheiden, was der Agent fährt — ein
Reseat, das nichts ändert, ist ein Neustart, und Neustarts haben ihren eigenen
Preis.

### 6.2 Zustandsmaschine

```
RUNNING
  │ reseat_agent
  ▼
SNAPSHOT        — commitWorktree, wenn schmutzig (C3-Pfad); Fakten festgehalten
  │
  ▼
PACKAGED        — Worker-Paket aus HOST-Zustand gebaut
  │
  ▼
SWAPPING        — Subtoken rotieren; PTY töten; Record, Slot, Name, Fragen behalten
  │
  ▼
SEEDING         — neues CLI im SELBEN Worktree spawnen; Rollen-Prompt +
  │               Contract (neuer Dialekt!) + Paket seeden
  ▼
RUNNING'        — generation + 1
```

Der Kill darf **nicht** über `terminate` laufen: Das gibt den Namen frei,
schließt das Fenster, entfernt den Registry-Eintrag und cancelt die offenen
Fragen des Agenten — genau die vier Dinge, die der Sitz behalten soll. Das ist
das Worker-Gegenstück zu C6s Regel „nicht über `stopWorkspace`“ und verdient
dieselbe ausdrückliche Notiz im Code.

Ein Fehler nach `SNAPSHOT` verliert nie Arbeit: Der Branch hält den Commit. Ein
Fehler in `SEEDING` lässt den Record `stopped` mit intaktem Worktree zurück und
emittiert `agent_reseat_failed` — von dort ist `start_agent{baseBranch}` ein
echter Fallback, weil die Arbeit dann *committet* ist.

Das Paket ist der C4-Block (`contract.ts`) mit den Feldern, die der Host schon
berechnet: Branch, `headSha`, `changedFiles`, `diffStat` aus dem Snapshot; die
letzte Zusammenfassung und das letzte `agent_done`-Result des Agenten; seine
offene Frage, falls vorhanden; und den **ursprünglichen Aufgabentext**. Letzterer
braucht ein neues gecapptes Feld auf `AgentRecord` (`lastAssignment`), gesetzt
dort, wo die Aufgabe zugestellt wird — ohne das muss der Orchestrator die
Aufgabe aus seinem eigenen Kontext neu senden, und genau diesen Kontext soll
ein Reseat aufhören zu verbrauchen.

### 6.3 Der Dialektwechsel

Ein Provider-Wechsel kann die MCP/Sentinel-Linie kreuzen, und das ist ein
Zustandswechsel im Record, nicht bloß anderes argv. `reportingForProvider`
leitet den Modus aus `mcp.kind === 'none'` ab, also:

- **mcp → sentinel:** Der Contract-Text muss mit dem Sentinel-Protokoll neu
  gebaut, `record.sentinel` erzeugt, der Stille-Watchdog scharfgestellt und
  `suppressSentinel` um den Seed herum behandelt werden.
- **sentinel → mcp:** Parser und Watchdog fallen weg, und der neue Prozess
  bekommt seine eigene Subagent-MCP-URL samt vorab genehmigter Tools.

Ebenfalls provider-spezifisch und daher pro Reseat neu gebaut: die Yolo-Flags
(D4-Stufen), die zusätzlichen MCP-Server des Slots (E6, Dialekt je Provider
verschieden) und die per `.git/info/exclude` ausgeblendeten Config-Dateien, die
pro Spawn mit einem `fileTag` geschrieben werden — der Tag muss die Generation
enthalten, damit keine veraltete Config des Vorgängers aufgegriffen wird.

---

## 7. In-Session-Modellwechsel (optionaler schneller Pfad)

Erst lohnend, wenn das Reseat existiert, denn es ist der einzige Pfad, der
*lügen* kann: Weist das CLI das Modell still zurück, glaubt der Host etwas über
den Lauf, das nicht stimmt.

Deskriptor-Oberfläche, optional und pro Provider:

```
modelSwitch?: { kind: 'slash', template: '/model {model}', confirm?: string }
```

Host-Regeln:

- Nur gleicher Provider. Eine `providerId` im Request bedeutet immer Reseat.
- Nur wenn der Agent **nicht mitten im Turn** ist — beim Worker zwischen zwei
  Aufgaben; beim Root nie über das PTY, solange `await_events` parkt (H1). In
  der Praxis fällt der Root damit vorerst ganz heraus, solange es keinen
  Nicht-PTY-Weg gibt, und das ist in Ordnung: Der Root hat den
  Succession-Pfad bereits.
- Gemessen wie der Seed-Handshake: tippen, dann aus dem Scrollback bestätigen
  (`confirm`-Muster oder der zurückkommende Modellname). Keine Bestätigung
  heißt, der Wechsel ist **gescheitert**, und der Record behält sein altes
  Modell.
- Bei Erfolg: `record.model` aktualisiert, `agent_model_changed` in die Queue.

Deklariert ein Provider nichts, existiert der schnelle Pfad für ihn nicht, und
jeder Wechsel ist ein Reseat. Das ist der ehrliche Default.

---

## 8. Auslöser: wer entscheidet

| Auslöser | Pfad | Anmerkung |
| --- | --- | --- |
| Orchestrator, für sich selbst | `request_succession{successor}` | Nur er kennt seinen eigenen Kontextdruck |
| Orchestrator, für einen Worker | `reseat_agent` | „Codex ist daran zweimal gescheitert, setz Claude drauf“ ist eine Orchestrierungsentscheidung |
| Mensch, auf dem Root | Panel/Remote „Orchestrator ersetzen“ bekommt einen Provider/Modell-Picker | Funktioniert auch auf einem toten Root |
| Mensch, auf einem Worker | Aktion auf der Agent-Karte → IPC → `reseat_agent`-Host-Pfad | Derselbe Host-Pfad wie das Tool, nie ein zweiter |
| Host, bei erkanntem Provider-Fehler | **Nur Hinweis-Event** | `discovery.ts` hat bereits `AUTH_FAILURE_PATTERN`; ein Rate-Limit-Muster im Scrollback verdient ein `provider_limit_suspected`-Event und eine Karte, keinen automatischen Wechsel |

Der Host wechselt nie von sich aus. Token-Budgets zu raten ist bereits eine
verworfene Idee (E4), und ein Host, der einen Worker hinter dem Rücken des
Orchestrators neu besetzt, bricht die eine Regel, auf der das ganze Harness
ruht: Host-Wahrheit zuerst, Host-*Entscheidungen* nie.

---

## 9. Events, Panel, Remote

Neue Mitglieder von `AGENT_EVENT_TYPES`:

| Event | Bedeutung |
| --- | --- |
| `agent_reseated` | `{agentId, generation, from:{providerId, model, effort}, to:{…}, reason}` |
| `agent_reseat_failed` | Seeding gescheitert; Record gestoppt, der Branch hält den Snapshot |
| `agent_model_changed` | In-Session-Wechsel bestätigt (§7) |
| `provider_limit_suspected` | Host-Beobachtung, keine Handlung |

`orchestrator_handoff_started` und `orchestrator_started` bekommen die
Sitz-Felder statt Geschwister — ein Reseat des Roots *ist* eine Succession.

Panel und Remote: Die Agent-Karte zeigt den lebenden Provider samt Modell (sie
zeigt den Record, das folgt also, sobald der Record stimmt) plus ein
Generations-Badge bei > 1, und die Run-Zusammenfassung listet, was der Sitz war.
Beide Sprachen, dazu `mainMessages.ts` für alles, was der Main-Process emittiert.

---

## 10. Fehlermodi

| Modus | Gegenmittel |
| --- | --- |
| Ziel-CLI fehlt oder ist ausgeloggt | Preflight weist ab, bevor etwas eingefroren oder getötet wird |
| Modellname falsch | Discovery-Warnung; der Spawn-Fehler selbst behält den Vorgänger (Root) bzw. den Snapshot (Worker) |
| Provider kann den Root-Sitz nicht halten | Harte Absage bei `mcp.kind === 'none'`, per Guard-Test gepinnt |
| Paket zu groß für einen PTY-belieferten Nachfolger | Engerer Cap + gemessener Handshake; lieber abweisen als halb seeden |
| Worker schmutzig beim Kill | Snapshot-Commit vor dem Kill; ein Git-Fehler bricht das Reseat ab |
| Zwei Prozesse auf einem Worktree | Der Kill wird vor dem Spawn abgewartet; die Generation im Record sperrt späte Ausgaben des Vorgängers |
| Veraltete Per-Agent-Config-Datei | `fileTag` enthält die Generation |
| Offene Frage mitten im Reseat | Registry behält sie; das Paket des Nachfolgers listet sie |
| Slot in der Lücke gestohlen | Die Reservierung wird nie freigegeben |
| Reseat während einer Succession | Beidseitig abweisen — ein Cutover pro Workspace zur Zeit |
| Reseat-Schleife (jeder neue Provider scheitert) | Aufeinanderfolgende Reseats pro Agent deckeln; die Absage ist ein Event, kein stiller Stopp |
| Resume nach Absturz | `meta.json` trägt den aktuellen Sitz, damit E3 nicht den Provider des Profils wiederbelebt |

---

## 11. Code-Touch-Liste (für die Umsetzung)

| Datei | Änderung |
| --- | --- |
| `src/shared/schema/provider.ts` | Optionaler `modelSwitch`-Deskriptor (nur §7) |
| `src/shared/schema/handoff.ts` | `successor`-Sitzblock; zwei neue Gründe |
| `src/shared/schema/events.ts` | Die vier Events aus §9 |
| `src/shared/schema/tasks.ts` | Nichts — dieselbe `ownerAgentId`, und das ist der Punkt |
| `src/shared/prompts/orchestrator.ts` | Wann reseaten, wann succeeden, wann stoppen; dass ein Reseat den Kontext des Workers kostet |
| `src/shared/prompts/contract.ts` | Reseat-Variante des C4-Handoff-Blocks |
| `src/shared/prompts/orchestratorHandoff.ts` | Den Sitzwechsel im Nachfolger-Seed rendern |
| `src/main/providers/health.ts`, `authStatus.ts`, `discovery.ts` | Als Preflight wiederverwendet; keine neuen Proben |
| `src/main/mcp/toolsOrchestrator.ts` | `reseat_agent`; `successor` an `request_succession`; Tool-Namenslisten (Root und Lead) |
| `src/main/mcp/types.ts` | Host-API für beides |
| `src/main/mcp/server.ts` | Subtoken-Rotation pro Generation |
| `src/main/workspace/Workspace.ts` | `seat`-Argument an `spawnOrchestratorRecord`; `reseatAgent`-Zustandsmaschine; Snapshot vor Kill; Slot halten; Dialektwechsel; `lastAssignment` im Record |
| `src/main/ipc.ts`, Panel, Remote | Picker an der Ersetzen-Aktion; Agent-Karten-Aktion; Badges |
| `src/shared/mainMessages.ts`, Renderer-i18n, Remote-i18n | Beide Sprachen |
| Tests | Siehe §12 |

---

## 12. Reihenfolge

```
M0  Diese Spec + Handbuch-Pointer (C7)
     │
M1  Root-Sitz-Override: successor{providerId, model, effort} + Preflight
    + die zwei neuen Gründe — nutzt den ganzen C6-Cutover
     │
M2  Host/Panel-Picker an „Orchestrator ersetzen“ (deckt den toten Root)
     │
M3  reseat_agent: Snapshot vor Kill, Record-Generation, Slot halten,
    Dialektwechsel, lastAssignment
     │
M4  In-Session-/model als schneller Pfad, provider-deklariert und gemessen
     │
M5  meta.json/Journal tragen den Sitz in E3-Resume; Live-Probe
```

M1 ist wirklich klein und für sich nützlich — es ist die Antwort auf einen
Root, der seinen Provider verloren hat. M3 ist das große Stück, weil es den
Lebenszyklus des Records anfasst. M4 darf für immer optional bleiben.

### Testplan

**Unit:** Preflight-Absagen (CLI fehlt, ausgeloggt, `mcp: none` für den Root);
das Sitz-Override erreicht das argv von `spawnAgent`; Reseat weist eine
Null-Änderung ab; Snapshot kommt vor dem Kill; `terminate` liegt nicht auf dem
Reseat-Pfad (Name, Fenster, Registry, Fragen überleben alle); Slot-Zählung über
die Lücke unverändert; Dialektwechsel erzeugt/zerstört den Sentinel-Parser;
Generation im `fileTag`; Reseat während einer Succession weist beidseitig ab.

**Integration:** voller MCP-Loop — Worker stellt eine Frage, wird reseatet, die
Frage bleibt danach beantwortbar; das `report_done` eines reseateten Workers
landet auf derselben `agentId` und demselben Branch; ein Sentinel-Worker auf
einen MCP-Provider reseatet meldet über das Tool und umgekehrt; ein Root-Reseat
auf einen zweiten Provider hält die Subagent-URLs gültig und macht den alten
`orchToken` ungültig.

**Live** (`VERTRAGUS_LIVE=1`): echter Claude-Root mitten im Lauf auf Codex
reseatet, mit laufenden Workern; echter Codex-Worker auf Claude reseatet, mit
nicht committeter Arbeit im Worktree — der Commit muss im Branch liegen und der
Nachfolger muss ihn sehen.

**Guard:** Jeder Provider-Deskriptor, der den Root-Sitz halten darf, deklariert
ein MCP-Attach; die Doku-Zwillinge dieser Datei bleiben synchron.

---

## 13. Non-Goals

- Automatisches Umschalten durch den Host anhand geratener Token-Zahlen oder
  Kostenbudgets
- Wechseln mitten im Turn oder einen laufenden Turn zum Wechseln unterbrechen
- Den eigenen Gesprächszustand eines CLI zwischen Providern migrieren (es gibt
  kein solches Format; das Paket *ist* der Transfer)
- Ein zweiter Merge- oder Branch-Pfad — ein Worker-Reseat nutzt seinen Branch
  weiter, ein Root-Reseat bekommt einen frischen Orch-Worktree wie heute
- Das Profil aus einer run-lokalen Entscheidung umschreiben
- Modell-Routing pro Turn, ein Router oder ein Kostenoptimierer
- Die Kinder eines Leads implizit mit-reseaten, wenn der Lead reseatet wird
- Tiefen- oder Verschachtelungsänderungen jeder Art — ein Reseat ersetzt, es
  fügt nie hinzu

---

## 14. Bezug zum Harness-Handbuch

Als **C7 Modell/Provider-Reseat** unter Phase C direkt nach C6 in
[`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md) vermerkt. Es braucht C3 (den
Snapshot-Commit, der ein Worker-Reseat sicher macht) und C6 (den Cutover, den es
erweitert); es ist unabhängig von F und keine zweite Produktoberfläche.
