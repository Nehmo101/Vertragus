interface ModelComboProps {
  className: string
  datalistId: string
  models: string[]
  value: string
  onChange(value: string): void
}

/**
 * Keeps free model input while offering an unfiltered catalogue picker.
 * Chromium filters a datalist by the input's current value, so the separate
 * select must stay independent from that value to always show every model.
 */
export default function ModelCombo({
  className,
  datalistId,
  models,
  value,
  onChange
}: ModelComboProps): JSX.Element {
  return (
    <>
      <div className="model-combo">
        <input
          className={className}
          list={datalistId}
          placeholder="CLI-Standard / Preset"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <select
          className="model-combo-picker"
          aria-label="Modell aus Liste wählen"
          title="Modell aus der vollständigen Liste wählen"
          value=""
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value)
          }}
        >
          <option value="">Liste ▾</option>
          {models.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
      </div>
      <datalist id={datalistId}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </>
  )
}
