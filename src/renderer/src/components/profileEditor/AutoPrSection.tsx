import { memo } from 'react'
import type { AutoPrConfig } from '@shared/profile'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './help'

interface AutoPrSectionProps {
  autoPr: AutoPrConfig
  /** Default branch of the bound GitHub repo (placeholder only). */
  boundDefaultBranch?: string
  onPatchAutoPr: (patch: Partial<AutoPrConfig>) => void
}

/** Auto-PR: Modus, Strategie, Basis-Branch und Quality Gates. */
const AutoPrSection = memo(function AutoPrSection({
  autoPr,
  boundDefaultBranch,
  onPatchAutoPr
}: AutoPrSectionProps): JSX.Element {
  return (
    <section className="automation-section" aria-labelledby="auto-pr-heading">
      <div className="slots-caption compact-caption">
        <span id="auto-pr-heading">Auto-PR</span>
        <span className="count">nur nach erfolgreichen Quality Gates</span>
      </div>
      <div className="automation-grid auto-pr-grid">
        <label>
          <span className="slot-col-label">
            Modus <InfoTip text={HELP.autoPrMode} />
          </span>
          <select
            className="slot-select-sm"
            value={autoPr.mode}
            onChange={(event) =>
              onPatchAutoPr({ mode: event.target.value as AutoPrConfig['mode'] })
            }
          >
            <option value="off">Aus</option>
            <option value="draft-after-checks">Draft nach Checks</option>
            <option value="ready-after-checks">Ready nach Checks</option>
            <option value="hold-for-approval">Vor Veröffentlichung freigeben</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            PR-Strategie <InfoTip text={HELP.prStrategy} />
          </span>
          <select
            className="slot-select-sm"
            value={autoPr.strategy}
            onChange={(event) =>
              onPatchAutoPr({ strategy: event.target.value as AutoPrConfig['strategy'] })
            }
          >
            <option value="aggregate">Ein gemeinsamer PR</option>
            <option value="per-task">Ein PR je Task</option>
          </select>
        </label>
        <label>
          <span className="slot-col-label">
            Basis-Branch <InfoTip text={HELP.baseBranch} />
          </span>
          <input
            className="slot-select-sm mono"
            placeholder={
              boundDefaultBranch ||
              autoPr.baseBranch ||
              'Gebundener Standardbranch'
            }
            value={autoPr.baseBranch}
            onChange={(event) => onPatchAutoPr({ baseBranch: event.target.value })}
          />
        </label>
        <label className="quality-gates-field">
          <span className="slot-col-label">
            Quality Gates (eine Zeile je Befehl) <InfoTip text={HELP.qualityGates} />
          </span>
          <textarea
            className="text-input mono quality-gates"
            value={autoPr.qualityGates.join('\n')}
            onChange={(event) =>
              onPatchAutoPr({
                qualityGates: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
              })
            }
          />
        </label>
      </div>
    </section>
  )
})

export default AutoPrSection
