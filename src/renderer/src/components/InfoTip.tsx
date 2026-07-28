import { useTranslation } from 'react-i18next'

interface InfoTipProps {
  text: string
  label?: string
}

export default function InfoTip({ text, label }: InfoTipProps): JSX.Element {
  const { t } = useTranslation()
  const effectiveLabel = label ?? t('ui.infoTip.label')
  return (
    <span
      className="info-tip"
      role="note"
      tabIndex={0}
      aria-label={`${effectiveLabel}: ${text}`}
      data-tooltip={text}
      title={text}
    >
      ?
    </span>
  )
}
