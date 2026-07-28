import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Options the popup shows. `query === null` means "the user did not type since
 * the list was opened" — then the complete catalogue is offered, even when a
 * model is already selected. Only actual typing narrows the list.
 *
 * This is the whole point of the component: a plain `<datalist>` is filtered by
 * Chromium against the input's current value, so a slot with `claude-sonnet-4-6`
 * saved only ever suggested that one entry and every other model looked gone.
 */
export function comboOptions(models: string[], query: string | null): string[] {
  const needle = query?.trim().toLowerCase()
  if (!needle) return models
  return models.filter((model) => model.toLowerCase().includes(needle))
}

/** Next highlighted index for ArrowUp/ArrowDown, wrapping at both ends. */
export function moveHighlight(current: number, delta: number, length: number): number {
  if (length === 0) return -1
  if (current < 0) return delta > 0 ? 0 : length - 1
  return (current + delta + length) % length
}

interface ModelComboProps {
  className: string
  /** DOM id of the popup listbox (one per slot / orchestrator). */
  id: string
  models: string[]
  value: string
  onChange(value: string): void
}

/**
 * Free-text model input with a catalogue popup.
 *
 * Free text stays first-class (providers accept ids we do not know yet), while
 * the ▾ button always opens the full list for the current provider — no
 * provider round-trip needed to see anything but the saved model.
 */
export default function ModelCombo({
  className,
  id,
  models,
  value,
  onChange
}: ModelComboProps): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // null = opened via the button (show everything); string = the user typed.
  const [query, setQuery] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputId = `${id}-input`
  const options = comboOptions(models, query)

  useEffect(() => {
    // The editor body scrolls, so a popup opened near its lower edge would be
    // clipped — pull it into view instead of leaving the list half-visible.
    if (open) listRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  useEffect(() => {
    if (!open) return
    // A click anywhere outside closes the popup — the input keeps its value.
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const close = (): void => {
    setOpen(false)
    setQuery(null)
    setHighlight(-1)
  }

  const commit = (model: string): void => {
    onChange(model)
    close()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setQuery(null)
        setHighlight(event.key === 'ArrowDown' ? 0 : models.length - 1)
        return
      }
      setHighlight((current) =>
        moveHighlight(current, event.key === 'ArrowDown' ? 1 : -1, options.length)
      )
      return
    }
    if (event.key === 'Enter' && open && options[highlight]) {
      event.preventDefault()
      commit(options[highlight]!)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
    }
  }

  return (
    <div className="model-combo" ref={rootRef}>
      <div className="model-combo-field">
        <input
          id={inputId}
          className={className}
          role="combobox"
          aria-expanded={open}
          aria-controls={id}
          aria-autocomplete="list"
          aria-activedescendant={
            open && options[highlight] ? `${id}-option-${highlight}` : undefined
          }
          autoComplete="off"
          placeholder={t('ui.modelCombo.placeholder')}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            setQuery(event.target.value)
            setHighlight(-1)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="model-combo-toggle"
          aria-label={t('ui.modelCombo.pickAria')}
          aria-expanded={open}
          aria-controls={id}
          title={t('ui.modelCombo.pickTitle')}
          disabled={models.length === 0}
          onClick={() => {
            // Reopening always starts from the full catalogue, never from the
            // saved model — otherwise the list collapses to a single entry again.
            setQuery(null)
            setHighlight(-1)
            setOpen((wasOpen) => !wasOpen)
          }}
        >
          ▾
        </button>
      </div>
      {open && (
        <div
          className="model-combo-list"
          id={id}
          ref={listRef}
          role="listbox"
          aria-labelledby={inputId}
        >
          {options.length === 0 ? (
            <div className="model-combo-empty">{t('ui.modelCombo.noMatch')}</div>
          ) : (
            options.map((model, index) => (
              <div
                key={model}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={model === value}
                className={`model-combo-option${index === highlight ? ' highlight' : ''}${
                  model === value ? ' selected' : ''
                }`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => {
                  // Commit before the input loses focus, so the outside-click
                  // listener cannot close the popup first.
                  event.preventDefault()
                  commit(model)
                }}
              >
                {model}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
