import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InboxSpeechSettings } from '@shared/inboxSpeech'
import { DEFAULT_TRANSCRIPTION_ENDPOINT, DEFAULT_TRANSCRIPTION_MODEL } from '@shared/inboxSpeech'
import { useAppStore } from '@renderer/store/useAppStore'

/**
 * Global speech-to-text (cloud STT) settings modal. Opened from the sidebar,
 * the workspace voice bar and the ideas inbox via the shared app store, so the
 * API key can be configured wherever the feature is used — not only from the
 * inbox. The key itself is stored encrypted in the main process and is never
 * returned to the renderer.
 */
export default function SpeechSettingsModal(): JSX.Element {
  const { t } = useTranslation()
  const close = useAppStore((state) => state.closeSpeechSettings)
  const bumpSpeechStatus = useAppStore((state) => state.bumpSpeechStatus)

  const [settings, setSettings] = useState<InboxSpeechSettings | null>(null)
  const [model, setModel] = useState(DEFAULT_TRANSCRIPTION_MODEL)
  const [language, setLanguage] = useState('de')
  const [endpointUrl, setEndpointUrl] = useState(DEFAULT_TRANSCRIPTION_ENDPOINT)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.vertragus.inboxSpeech.getSettings().then((s) => {
      setSettings(s)
      setModel(s.model)
      setLanguage(s.language)
      setEndpointUrl(s.endpointUrl)
      setApiKey('')
      setError('')
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await window.vertragus.inboxSpeech.setSettings({
        model,
        language,
        endpointUrl,
        ...(apiKey ? { apiKey } : {})
      })
      setApiKey('')
      bumpSpeechStatus()
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await window.vertragus.inboxSpeech.setSettings({ apiKey: '' })
      setApiKey('')
      setSettings((current) => (current ? { ...current, hasApiKey: false } : current))
      bumpSpeechStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="confirm-backdrop" onClick={close} />
      <div className="confirm-pop inbox-speech-settings" role="dialog" aria-modal="true">
        <div className="head">
          <b>{t('speech.title')}</b>
        </div>
        <div className="text">
          {t('speech.note')}
        </div>
        <label className="inbox-field">
          <span>{t('speech.model')}</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="inbox-field">
          <span>{t('speech.language')}</span>
          <input value={language} onChange={(e) => setLanguage(e.target.value)} />
        </label>
        <label className="inbox-field">
          <span>{t('speech.endpoint')}</span>
          <input value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} />
        </label>
        <label className="inbox-field">
          <span>
            {t('speech.apiKey')} {settings?.hasApiKey ? t('speech.apiKeyStored') : ''}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings?.hasApiKey ? '••••••••' : 'sk-…'}
            autoComplete="off"
          />
        </label>
        {error && <div className="inbox-error">{error}</div>}
        <div className="actions">
          {settings?.hasApiKey && (
            <button type="button" className="btn-ghost" disabled={saving} onClick={() => void clearKey()}>
              {t('speech.deleteKey')}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={close}>
            {t('speech.cancel')}
          </button>
          <button type="button" className="btn-primary" disabled={saving} onClick={() => void save()}>
            {t('speech.save')}
          </button>
        </div>
      </div>
    </>
  )
}
