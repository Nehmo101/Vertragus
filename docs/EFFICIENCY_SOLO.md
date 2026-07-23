# Efficiency Solo — Ein-Agent-Profil mit minimalem Tokenverbrauch

Stand: 2026-07-22

## Was es ist

Das Profil-Preset **„Efficiency Solo"** (`EFFICIENCY_SOLO_PROFILE` in
`src/shared/profilePresets.ts`) startet genau **einen** Agenten, der das Ziel
direkt selbst bearbeitet: kein Orchestrator-Prozess, keine Delegation, kein
Plan-DAG. Der Agent bekommt:

- den **kompakten Solo-Kontrakt** als Systemprompt (`soloLaunch.ts`, ~10 Zeilen
  statt ~90 Zeilen Orchestrator-Kontrakt),
- das **geprüfte Retro-Learnings-Overlay** (`promptOverlay.ts`, ≤ 80 Zeilen /
  16 KB) unverändert injiziert — er profitiert vom Teamwissen aller früheren
  Läufe,
- eine **minimale MCP-Session** (`buildSoloMcpServer`): nur `report_activity`
  und `record_retro`. Die Session liefert bei `tools/list` wirklich nur diese
  beiden Tools — der volle 29-Tool-Schemablock des Orchestrator-Servers landet
  nie im Kontext. Das ist der Mechanismus, keine bloße Client-Allowlist.

Am Ende jedes Laufs speichert der Solo-Agent per `record_retro` Fazit und
Modell-Erkenntnisse — der Solo-Modus **speist** die Lernschleife also weiter,
aus der er seine Spezialisierung bezieht.

## Warum das Tokens spart (die Hebel im Einzelnen)

| Hebel | Mechanismus | Wirkung |
| --- | --- | --- |
| Kein Orchestrator-Systemprompt | ~90 Zeilen Planvertrag/Regelkreis entfallen | Fixkosten pro Session |
| Kein voller MCP-Schemablock | Solo-Session registriert 2 statt 29 Tools (inkl. des großen verschachtelten `execute_plan`-Schemas) | Fixkosten **pro Turn** — der größte Einzelposten |
| Null Delegations-Roundtrips | Kein `dispatch_*`/`await_*`-Zyklus; jeder Dispatch kostet sonst einen kompletten Worker-Kontextaufbau plus Orchestrator-Warteturns | Variable Kosten pro Teilaufgabe |
| Keine Plan-DAG-Zeremonie | Kein Plan-JSON, keine Validierungsschleifen, keine Retro-Draft-Roundtrips | Variable Kosten pro Ziel |
| Learnings-Overlay | Bekannte Fehlerquellen (aus 26+ Retros) stehen im Prompt → weniger fehlgeschlagene Anläufe und Retries | Variable Kosten, Qualität |
| Benchmark-basierte Modellwahl | `recommendSoloModel` (`src/shared/retro/soloModel.ts`) rankt Modelle nach Ø-Benchmark-Score ± Learning-Bilanz; Anzeige im Profil-Editor | Vermeidet überprovisionierte Modelle |

**Größenordnung:** Für nicht parallelisierbare Ziele kollabieren
1 Orchestrator-Kontext + N Worker-Kontexte in **einen** langlebigen Kontext.
Konservativ gerechnet (Orchestrator-Fixkosten pro Turn + je Task ein
Worker-Bring-up) liegt die Ersparnis typischerweise **über 50 %** der
Gesamttokens; bei kleinen Zielen mit 1–2 Tasks noch deutlich höher.

## Wann Solo die richtige Wahl ist

`src/shared/planEstimate.ts` berechnet bereits deterministisch eine
Delegationsempfehlung (`solo` vs. `delegate`) aus der DAG-Struktur: Ein Ziel,
dessen Teilaufgaben eine Abhängigkeitskette bilden (effektive Parallelbreite 1),
profitiert nicht von einem Team. Genau diese Fälle sind der Sweet Spot des
Presets. Umgekehrt gilt: Echte parallele Ziele (Breite ≥ 2) bleiben beim
Orchestrator-Profil — Solo serialisiert sie zwangsläufig.

## Wie sich der Agent weiter „spezialisiert"

1. **Retros → Overlay:** Jeder Lauf endet mit `record_retro`; die wöchentliche
   Retro-Analyse destilliert daraus das menschlich geprüfte
   `overlay/learnings.md`, das der Solo-Agent beim nächsten Start im Prompt hat.
2. **Benchmarks → Modellwahl:** `run_benchmark`-Läufe aus Benchmark-Profilen
   füttern `recommendSoloModel`; der Editor zeigt die beste Provider/Modell-
   Kombination für Solo-Arbeit an.
3. **Learnings → Stärken/Schwächen:** Gespeicherte Modell-Erkenntnisse fließen
   über „Learnings anwenden" in die Slot-Konfiguration.

## Grenzen

- Provider ohne verifizierten MCP-Adapter (Cursor, Ollama) degradieren
  anmutig: Der Agent startet normal, aber ohne Solo-Tools und Overlay-Prompt.
- Solo umgeht bewusst Multi-Agent-Features (Benchmark, Multiagent-Rennen,
  Auto-PR-Aggregation über mehrere Tasks); das Schema erzwingt diese
  Deaktivierung (`superRefine` in `src/shared/profile.ts`).
