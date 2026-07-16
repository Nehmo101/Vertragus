import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CollapsedOrchestratorPanel } from './OrchestratorPanel'

describe('OrchestratorPanel collapsed layout', () => {
  it('frees its configured width and retains an accessible expand control', () => {
    const markup = renderToStaticMarkup(
      createElement(CollapsedOrchestratorPanel, { onToggle: (): void => undefined })
    )

    expect(markup).toContain('panel-collapsed')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-label="Orchestrator-Seitenleiste ausklappen"')
    expect(markup).not.toContain('style="width:360px"')
    expect(markup).not.toContain('role="separator"')
  })
})
