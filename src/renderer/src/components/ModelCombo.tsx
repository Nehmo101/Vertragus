import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  collapseModelVariants,
  groupModelVariantsByFamily,
  type ModelVariant
} from '@shared/models'

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

/**
 * Collapsed display rows for the popup: punctuation twins fold into one row,
 * dated snapshots into their base row (kept as tooltip). Typing also matches a
 * folded snapshot id, so searching a date still finds the base row.
 */
export function comboVariantRows(models: string[], query: string | null): ModelVariant[] {
  const variants = collapseModelVariants(models)
  const needle = query?.trim().toLowerCase()
  if (!needle) return variants
  return variants.filter(
    (variant) =>
      variant.id.toLowerCase().includes(needle) ||
      variant.snapshots.some((snapshot) => snapshot.toLowerCase().includes(needle))
  )
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
  // Grouped by family, alias first: `opus` and `claude-opus-5` are the same
  // model line — one rolling, one pinned — so the popup shows them as one
  // labeled family block instead of unrelated rows. Punctuation twins and dated
  // snapshots are collapsed (snapshots survive as tooltip). Keyboard order
  // follows the rendered order.
  const groups = useMemo(
    () => groupModelVariantsByFamily(comboVariantRows(models, query)),
    [models, query]
  )
  const options = useMemo(
    () =>
      groups.flatMap((group) => [
        ...(group.alias ? [group.alias.id] : []),
        ...group.pinned.map((variant) => variant.id)
      ]),
    [groups]
  )

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
        setHighlight(event.key === 'ArrowDown' ? 0 : options.length - 1)
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
            groups.map((group) => {
              const rows = [
                ...(group.alias ? [{ variant: group.alias, rolling: true }] : []),
                ...group.pinned.map((variant) => ({ variant, rolling: false }))
              ]
              return (
                <div className="model-combo-group" key={group.family}>
                  {rows.length > 1 && (
                    <div className="model-combo-family-head" aria-hidden="true">
                      {group.family}
                    </div>
                  )}
                  {rows.map(({ variant, rolling }) => {
                    const model = variant.id
                    const index = options.indexOf(model)
                    const snapshotTitle =
                      variant.snapshots.length > 0
                        ? t('ui.modelCombo.snapshotTitle', {
                            ids: variant.snapshots.join(', ')
                          })
                        : undefined
                    return (
                      <div
                        key={model}
                        id={`${id}-option-${index}`}
                        role="option"
                        aria-selected={model === value}
                        title={snapshotTitle}
                        className={`model-combo-option${index === highlight ? ' highlight' : ''}${
                          model === value ? ' selected' : ''
                        }${rolling ? ' rolling' : ' pinned'}${rows.length > 1 ? ' in-family' : ''}`}
                        onMouseEnter={() => setHighlight(index)}
                        onMouseDown={(event) => {
                          // Commit before the input loses focus, so the outside-click
                          // listener cannot close the popup first.
                          event.preventDefault()
                          commit(model)
                        }}
                      >
                        <span>{model}</span>
                        {variant.snapshots.length > 0 && (
                          <span className="model-combo-tag snapshots" title={snapshotTitle}>
                            +{variant.snapshots.length}
                          </span>
                        )}
                        {rolling && (
                          <span className="model-combo-tag" title={t('ui.modelCombo.rollingTitle')}>
                            {t('ui.modelCombo.rolling')}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
