import { describe, expect, it } from 'vitest'
import { buildHeadlessLaunch, buildInteractiveLaunch } from './types'

describe('provider model argument passing', () => {
  const opts = { model: 'chosen-model', workingDir: 'C:\\repo', yolo: false }

  it.each(['claude', 'kimi', 'cursor', 'copilot'] as const)(
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

    expect(interactive.args).toEqual([
      '--model',
      'chosen-model',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '-c',
      'approvals_reviewer=' + JSON.stringify('auto_review'),
      '--no-alt-screen',
      '-c',
      'tui.animations=false'
    ])
    expect(headless.args).toEqual([
      'exec',
      '--model',
      'chosen-model',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy=' + JSON.stringify('never'),
      '--ephemeral',
      'do work'
    ])
    expect(headless.args).not.toContain('--ask-for-approval')
    expect([...interactive.args, ...headless.args]).not.toContain('model=chosen-model')
  })

  it('keeps Codex standard and explicit Yolo execution mutually exclusive', () => {
    const standard = buildHeadlessLaunch('codex', 'do work', {
      ...opts,
      extraArgs: ['-c', 'mcp_servers.demo.enabled=true']
    }).args
    const yolo = buildHeadlessLaunch('codex', 'do work', { ...opts, yolo: true }).args

    expect(standard).toEqual([
      'exec',
      '--model',
      'chosen-model',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy=' + JSON.stringify('never'),
      '--ephemeral',
      '-c',
      'mcp_servers.demo.enabled=true',
      'do work'
    ])
    expect(standard).not.toContain('--ask-for-approval')
    expect(yolo).not.toContain('--ask-for-approval')
    expect(standard).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(yolo).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(yolo).toContain('--ephemeral')
    expect(yolo).not.toContain('--sandbox')
    expect(yolo.at(-1)).toBe('do work')
  })

  it('stabilizes Codex interactive rendering in both safe and Yolo mode', () => {
    const standard = buildInteractiveLaunch('codex', opts).args
    const yolo = buildInteractiveLaunch('codex', { ...opts, yolo: true }).args

    for (const args of [standard, yolo]) {
      expect(args).toContain('--no-alt-screen')
      expect(args).toContain('tui.animations=false')
    }
    expect(standard).toEqual(expect.arrayContaining(['--ask-for-approval', 'on-request']))
    expect(standard).toContain('approvals_reviewer=' + JSON.stringify('auto_review'))
    expect(yolo).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(yolo.join(' ')).not.toContain('approvals_reviewer')
    expect(yolo).not.toContain('--ask-for-approval')
  })

  it('omits model flags for cloud provider CLI defaults', () => {
    const withoutModel = { ...opts, model: undefined }
    for (const provider of ['claude', 'kimi', 'codex', 'cursor', 'copilot'] as const) {
      expect(buildInteractiveLaunch(provider, withoutModel).args).not.toContain('--model')
      expect(buildHeadlessLaunch(provider, 'do work', withoutModel).args).not.toContain('--model')
    }
  })

  it('drives the Kimi CLI with Claude-style stream-json headless args', () => {
    const interactive = buildInteractiveLaunch('kimi', opts)
    const headless = buildHeadlessLaunch('kimi', 'do work', { ...opts, yolo: true })

    expect(interactive.command).toBe('kimi')
    expect(interactive.args).toEqual(['--model', 'chosen-model'])
    expect(headless.command).toBe('kimi')
    expect(headless.args).toEqual([
      '-p',
      'do work',
      '--output-format',
      'stream-json',
      '--model',
      'chosen-model',
      '--dangerously-skip-permissions'
    ])
  })

  it('never silently substitutes an uninstalled Ollama model', () => {
    const withoutModel = { ...opts, model: undefined }
    expect(() => buildInteractiveLaunch('ollama', withoutModel)).toThrow(/Modell/)
    expect(() => buildHeadlessLaunch('ollama', 'do work', withoutModel)).toThrow(/Modell/)
  })

  it('trusts Cursor workspaces noninteractively for headless tasks', () => {
    const args = buildHeadlessLaunch('cursor', 'do work', opts).args
    expect(args).toContain('--trust')
    expect(args.indexOf('--trust')).toBeLessThan(args.indexOf('--model'))
  })
})

const baseOpts = {
  model: 'sonnet',
  workingDir: '/repo',
  yolo: false
}

describe('buildInteractiveLaunch Claude permission mode', () => {
  it('adds acceptEdits for auto mode', () => {
    expect(
      buildInteractiveLaunch('claude', { ...baseOpts, permissionMode: 'auto' }).args
    ).toEqual(['--model', 'sonnet', '--permission-mode', 'acceptEdits'])
  })

  it('adds plan mode', () => {
    expect(
      buildInteractiveLaunch('claude', { ...baseOpts, permissionMode: 'plan' }).args
    ).toEqual(['--model', 'sonnet', '--permission-mode', 'plan'])
  })

  it.each([undefined, 'default'] as const)('adds no flag for %s', (permissionMode) => {
    expect(
      buildInteractiveLaunch('claude', { ...baseOpts, permissionMode }).args
    ).toEqual(['--model', 'sonnet'])
  })

  it('lets Yolo override the configured permission mode', () => {
    const args = buildInteractiveLaunch('claude', {
      ...baseOpts,
      yolo: true,
      permissionMode: 'auto'
    }).args

    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--permission-mode')
  })

  it('does not change other providers', () => {
    expect(
      buildInteractiveLaunch('codex', { ...baseOpts, permissionMode: 'auto' }).args
    ).toEqual(['--model', 'sonnet'])
  })
})

describe('buildHeadlessLaunch Claude permission mode', () => {
  it('adds acceptEdits for auto mode', () => {
    expect(
      buildHeadlessLaunch('claude', 'Do the task', {
        ...baseOpts,
        permissionMode: 'auto'
      }).args
    ).toEqual([
      '-p',
      'Do the task',
      '--output-format',
      'stream-json',
      '--model',
      'sonnet',
      '--permission-mode',
      'acceptEdits'
    ])
  })
})
