interface InfoTipProps {
  text: string
  label?: string
}

export default function InfoTip({ text, label = 'Feldhilfe' }: InfoTipProps): JSX.Element {
  return (
    <span
      className="info-tip"
      role="note"
      tabIndex={0}
      aria-label={`${label}: ${text}`}
      data-tooltip={text}
      title={text}
    >
      ?
    </span>
  )
}
