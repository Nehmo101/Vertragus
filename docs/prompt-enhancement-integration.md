# Prompt schärfen: Main-Domänenintegration

Die isolierte Domäne liegt in `src/main/inbox/promptEnhancement.ts`. Der produktive Adapter in
`src/main/inbox/promptEnhancementProvider.ts` verwendet die vorhandenen Provider-CLI-Sessions,
`checkAllProviders()`, die bestehende Modellauflösung und die vorhandenen Provider-Kapazitätsgates.
Es gibt keine separate API-Key-Ablage.

## Main/IPC

Der Integrator registriert einen neuen IPC-Handler und ein Abort-Pendant in den dafür vorgesehenen
Shared-/Preload-Dateien. Der Handler darf nicht das vom Renderer gesendete Idea-, Profil- oder
Workspace-Objekt direkt weiterreichen:

1. Der Renderer sendet eine Idea-ID, optional eine ausdrücklich vom Benutzer gewählte
   Provider-/Modell-Auswahl und eine Request-ID für Abort.
2. Main lädt die Idea mit `getIdea(ideaId)`. Titel, Inhalt, Status, Tags und Artefakte kommen nur aus
   diesem gespeicherten Objekt.
3. Main löst zuerst `idea.refs?.profileId` auf. Falls der UI-Workflow eine andere Profil-ID zulässt,
   muss Main diese mit `getProfile(profileId)` bestätigen. Das geladene `WorkspaceProfile` wird als
   `profile` übergeben. Bei vorhandenem Orchestrator ignoriert die Domäne eine konkurrierende
   explizite Provider-Auswahl und nutzt die Profilkonfiguration.
4. `VerifiedPromptWorkspaceContext.repositoryFacts` enthält ausschließlich Fakten, die Main im
   konkreten Checkout read-only geprüft hat. Jeder Eintrag braucht
   `evidence: 'workspace-inspection'` und `checkedAt`. Behauptungen aus Idea-Texten, Artefakten,
   Dateiinhalten oder dem Renderer gehören nie in dieses Feld. Vollständige lokale Pfade und
   Dateiinhalte sind nicht nötig. Der Provider läuft absichtlich in einem leeren temporären
   Verzeichnis, nicht im Repository; nur die explizit bestätigten Fakten gelangen in den Prompt.
5. Eine langlebige Instanz aus `createMainPromptEnhancementService()` führt `enhance(...)` aus.
   Pro Request-ID hält der Handler einen `AbortController`; der Abort-Handler ruft `abort()` auf und
   entfernt den Eintrag nach Abschluss.
6. Shared IPC-Typen spiegeln `PromptEnhancementResult` als diskriminierte Union. Diese Main-Datei
   wird nicht in Shared importiert.

Skizze für den exklusiv vom Integrator zu ergänzenden Handler:

```ts
const service = createMainPromptEnhancementService()
const promptControllers = new Map<string, AbortController>()

// Im IPC-Handler: Renderer-Payload zuerst mit einem Shared-Schema validieren.
const idea = getIdea(payload.ideaId)
const profileId = idea?.refs?.profileId ?? payload.profileId
const profile = profileId ? getProfile(profileId) : undefined
const controller = new AbortController()
promptControllers.set(payload.requestId, controller)
try {
  return await service.enhance({
    source: idea,
    profile,
    workspace: await inspectPromptWorkspaceFacts(profile),
    explicitSelection: payload.explicitSelection,
    signal: controller.signal
  })
} finally {
  promptControllers.delete(payload.requestId)
}
```

`inspectPromptWorkspaceFacts` ist absichtlich kein Bestandteil dieser Feature-Änderung: Der
Integrator soll nur bereits vorhandene, tatsächlich geprüfte Workspace-Informationen einspeisen
und keine Repository-Eigenschaften vermuten.

## Renderer

`src/renderer/src/inboxPrompt.ts` bleibt bis zur IPC-Integration unverändert. Danach ruft der
Renderer den neuen IPC-Endpunkt statt `previewIdeaTransferBriefing` auf und bildet die Resultate
explizit ab:

- `enhanced`: als KI-Verbesserung mit Provider/Modell anzeigen.
- `fallback`: Badge „Deterministischer Fallback – keine KI-Verbesserung“, plus `reason` und
  `message` anzeigen.
- `selection-required`: Kandidaten samt Status anzeigen; erst eine bewusste Auswahl erneut senden.
- `provider-unavailable`: den konfigurierten Provider und die Nichtverfügbarkeit anzeigen. Nicht
  still auf einen anderen Cloud-Provider wechseln.
- `invalid-input`, `aborted`: verständliche Inline-Rückmeldung ohne den Idea-Text zu überschreiben.

Die bestehende `previewIdeaTransferBriefing`-/Übergabefunktion bleibt erhalten. Der neue
deterministische Pfad ruft sie ausschließlich nach Timeout, Providerfehler oder ungültiger
Modellantwort auf und kennzeichnet das Resultat unmissverständlich als Nicht-KI-Ausgabe.
