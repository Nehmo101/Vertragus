import type { AgentInstanceInfo } from '@shared/agents'
import { useInboxSpeech } from '@renderer/hooks/useInboxSpeech'

const STATE_LABEL = {
  idle: 'Bereit',
  recording: 'Aufnahme läuft',
  transcribing: 'Transkribiere…',
  review: 'Vorschau prüfen',
  failed: 'Fehler'
} as const

export default function VoiceBar({ agent }: { agent?: AgentInstanceInfo }): JSX.Element {
  const speech = useInboxSpeech()
  const available = Boolean(agent && (agent.status === 'running' || agent.status === 'waiting'))
  const text = speech.voiceDraft?.content ?? ''

  const deliver = (send: boolean): void => {
    if (!agent || !text.trim()) return
    window.orca.agents.write(agent.id, `${text.trim()}${send ? '\r' : ''}`)
    speech.discardVoiceDraft()
  }

  return (
    <section className="voice-bar" aria-label="Sprachsteuerung für ausgewählten Agent">
      <div className="voice-target">
        <span className="voice-label">Sprache an</span>
        <strong>{agent?.name ?? 'keinen Agent ausgewählt'}</strong>
        {agent?.branch && <code>{agent.branch}</code>}
      </div>
      <span className={`voice-state state-${speech.state}`}>{STATE_LABEL[speech.state]}</span>
      <button
        type="button"
        className={`voice-record ${speech.state === 'recording' ? 'active' : ''}`}
        disabled={!available || speech.state === 'review'}
        aria-pressed={speech.state === 'recording'}
        title={
          !speech.status?.configured
            ? 'STT-Zugang zuerst in der Ideen-Inbox konfigurieren'
            : speech.state === 'recording'
              ? 'Aufnahme beenden'
              : 'Push-to-talk starten'
        }
        onClick={() => void speech.toggleRecording()}
      >
        {speech.state === 'recording' ? '■ Stop' : speech.state === 'transcribing' ? '× Abbrechen' : '● Aufnehmen'}
      </button>
      {speech.voiceDraft && (
        <div className="voice-review">
          <textarea
            aria-label="Transkript vor dem Senden bearbeiten"
            value={speech.voiceDraft.content}
            onChange={(event) => speech.updateVoiceDraft({ content: event.target.value })}
          />
          <button type="button" className="btn ghost" onClick={() => speech.discardVoiceDraft()}>
            Verwerfen
          </button>
          <button type="button" className="btn ghost" onClick={() => deliver(false)}>
            Einfügen
          </button>
          <button type="button" className="btn primary" onClick={() => deliver(true)}>
            Senden
          </button>
        </div>
      )}
      {speech.error && <span className="voice-error" role="alert">{speech.error}</span>}
    </section>
  )
}
