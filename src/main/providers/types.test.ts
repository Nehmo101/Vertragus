import { describe, expect, it } from 'vitest'
import { buildHeadlessLaunch, buildInteractiveLaunch } from './types'

describe('provider model argument passing', () => {
  const opts = { model: 'chosen-model', workingDir: 'C:\\repo', yolo: false }

  it.each(['claude', 'cursor', 'copilot'] as const)(
    'passes the selected model to %s interactive and headless launches',
    (provider) => {
      expect(buildInteractiveLaunch(provider, opts).args).toEqual(
        expect.arrayContaining(['--model', 'chosen-model'])
      )
      expect(buildHeadlessLaunch(provider, 'do work', opts).args).toEqual(
        expect.arrayContaining(['--model', 'chosen-model'])
      )
    }
  )

  it('uses Codex dedicated model flags instead of a generic config override', () => {
    const interactive = buildInteractiveLaunch('codex', opts)
    const headless = buildHeadlessLaunch('codex', 'do work', opts)

    expect(interactive.args).toEqual(['--model', 'chosen-model'])
    expect(headless.args.slice(0, 4)).toEqual(['exec', '--model', 'chosen-model', 'do work'])
    expect([...interactive.args, ...headless.args]).not.toContain('model=chosen-model')
  })

  it('omits model flags for cloud provider CLI defaults', () => {
    const withoutModel = { ...opts, model: undefined }
    for (const provider of ['claude', 'codex', 'cursor', 'copilot'] as const) {
      expect(buildInteractiveLaunch(provider, withoutModel).args).not.toContain('--model')
      expect(buildHeadlessLaunch(provider, 'do work', withoutModel).args).not.toContain('--model')
    }
  })

  it('never silently substitutes an uninstalled Ollama model', () => {
    const withoutModel = { ...opts, model: undefined }
    expect(() => buildInteractiveLaunch('ollama', withoutModel)).toThrow(/Modell/)
    expect(() => buildHeadlessLaunch('ollama', 'do work', withoutModel)).toThrow(/Modell/)
  })
})
