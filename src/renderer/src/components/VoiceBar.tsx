import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentInstanceInfo } from '@shared/agents'
import { useInboxSpeech } from '@renderer/hooks/useInboxSpeech'
import { useAppStore, workspaceAgents } from '@renderer/store/useAppStore'
import {
  speechShortcutAriaKeys,
  speechShortcutKeys,
  useSpeechShortcutContext
} from '@renderer/features/speechShortcut/SpeechShortcutProvider'

type VoiceTarget = 'agent' | 'orchestrator'

export default function VoiceBar({ agent }: { agent?: AgentInstanceInfo }): JSX.Element {
  const { t } = useTranslation()
  const speech = useInboxSpeech()
  const store = useAppStore()
  const openSpeechSettings = store.openSpeechSettings
  const orchestratorAgent = workspaceAgents(store).find(
    (candidate) => candidate.kind === 'orchestrator'
  )
  const [target, setTarget] = useState<VoiceTarget>('agent')

  const effectiveTarget: AgentInstanceInfo | undefined =
    target === 'orchestrator' ? (orchestratorAgent ?? agent) : agent
  const configured = speech.status?.configured ?? false
  const available = Boolean(
    effectiveTarget &&
      (effectiveTarget.status === 'running' || effectiveTarget.status === 'waiting')
  )
  const text = speech.voiceDraft?.content ?? ''

  // Ctrl/Cmd+Shift+M → speech.toggle routes here while the VoiceBar is mounted (active context).
  const shortcutContext = useMemo(
    () => ({ configured, state: speech.state, toggleRecording: speech.toggleRecording }),
    [configured, speech.state, speech.toggleRecording]
  )
  useSpeechShortcutContext('voice-bar', shortcutContext)
  const shortcutKeys = speechShortcutKeys()
  const shortcutAriaKeys = speechShortcutAriaKeys()

  const deliver = (send: boolean): void => {
    if (!effectiveTarget || !text.trim()) return
    window.orca.agents.write(effectiveTarget.id, `${text.trim()}${send ? '\r' : ''}`)
    speech.discardVoiceDraft()
  }

  return (
    <section className="voice-bar" aria-label={t('voice.aria')}>
      <div className="voice-target">
        <span className="voice-label">{t('voice.sendTo')}</span>
        <div className="voice-target-switch" role="group" aria-label={t('voice.targetGroup')}>
          <button
            type="button"
            className={`voice-target-btn ${target === 'agent' ? 'active' : ''}`}
            aria-pressed={target === 'agent'}
            onClick={() => setTarget('agent')}
          >
            {agent?.name ?? t('voice.noAgent')}
          </button>
          <button
            type="button"
            className={`voice-target-btn orchestrator ${target === 'orchestrator' ? 'active' : ''}`}
            aria-pressed={target === 'orchestrator'}
            disabled={!orchestratorAgent}
            title={orchestratorAgent ? undefined : t('voice.noOrchestrator')}
            onClick={() => setTarget('orchestrator')}
          >
            ◆ {orchestratorAgent?.name ?? t('voice.orchestrator')}
          </button>
        </div>
        {effectiveTarget?.branch && <code>{effectiveTarget.branch}</code>}
      </div>
      <span className={`voice-state state-${speech.state}`}>
        {t(`voice.state.${speech.state}`)}
      </span>
      {speech.state === 'recording' && (
        <span className="vwave" aria-hidden="true">
          <i /><i /><i /><i /><i />
        </span>
      )}
      <button
        type="button"
        className={`voice-record ${speech.state === 'recording' ? 'active' : ''}`}
        disabled={!available || speech.state === 'review'}
        aria-pressed={speech.state === 'recording'}
        aria-keyshortcuts={shortcutAriaKeys}
        title={`${
          !configured
            ? t('voice.configureFirst')
            : speech.state === 'recording'
              ? t('voice.stopTitle')
              : t('voice.recordTitle')
        } · ${t('voice.shortcutHint', { keys: shortcutKeys })}`}
        onClick={() => void speech.toggleRecording()}
      >
        {speech.state === 'recording'
          ? `■ ${t('voice.stop')}`
          : speech.state === 'transcribing'
            ? `× ${t('voice.cancel')}`
            : `● ${t('voice.record')}`}
      </button>
      <kbd className="voice-shortcut" title={t('voice.shortcutHint', { keys: shortcutKeys })}>
        {shortcutKeys}
      </kbd>
      <button
        type="button"
        className={`voice-settings ${configured ? '' : 'unconfigured'}`}
        title={t('voice.settingsTitle')}
        aria-label={t('voice.settingsAria')}
        onClick={() => openSpeechSettings()}
      >
        ⚙
      </button>
      {speech.voiceDraft && (
        <div className="voice-review">
          <textarea
            aria-label={t('voice.reviewAria')}
            value={speech.voiceDraft.content}
            onChange={(event) => speech.updateVoiceDraft({ content: event.target.value })}
          />
          <button type="button" className="btn ghost" onClick={() => speech.discardVoiceDraft()}>
            {t('voice.discard')}
          </button>
          <button type="button" className="btn ghost" onClick={() => deliver(false)}>
            {t('voice.insert')}
          </button>
          <button type="button" className="btn primary" onClick={() => deliver(true)}>
            {t('voice.send')}
          </button>
        </div>
      )}
      {speech.error &&
        (configured ? (
          <span className="voice-error" role="alert">{speech.error}</span>
        ) : (
          <button
            type="button"
            className="voice-error voice-error-action"
            role="alert"
            title={t('voice.errorSetupTitle')}
            onClick={() => openSpeechSettings()}
          >
            {speech.error} — {t('voice.errorSetupAction')}
          </button>
        ))}
    </section>
  )
}
