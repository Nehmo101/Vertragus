import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import i18n from '@renderer/i18n'
import { CollapsedOrchestratorPanel } from './OrchestratorPanel'

// The suite asserts the authored German strings; force the de locale.
beforeAll(async () => {
  await i18n.changeLanguage('de')
})

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
