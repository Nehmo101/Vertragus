import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 10_000

interface ActiveCommand {
  controller: AbortController
  settled: Promise<void>
}

/** Tracks test-only Git processes so timed-out tests cannot race temp cleanup. */
export class GitTestHarness {
  private readonly active = new Set<ActiveCommand>()

  async git(cwd: string, ...args: string[]): Promise<string> {
    const controller = new AbortController()
    const process = execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      signal: controller.signal
    })
    const command: ActiveCommand = {
      controller,
      settled: process.then(() => undefined, () => undefined)
    }
    this.active.add(command)

    try {
      const { stdout } = await process
      return stdout.trim()
    } finally {
      this.active.delete(command)
    }
  }

  async cleanup(paths: string[]): Promise<void> {
    const active = [...this.active]
    for (const command of active) command.controller.abort()
    await Promise.all(active.map((command) => command.settled))

    for (const path of paths) {
      await rm(path, {
        recursive: true,
        force: true,
        maxRetries: 6,
        retryDelay: 100
      })
    }
  }
}
