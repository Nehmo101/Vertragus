import { execFile } from 'node:child_process'
import { shell } from 'electron'
import { resolveLaunch } from '@main/agents/resolveCommand'

interface OpenInEditorDeps {
  resolve: typeof resolveLaunch
  exec: (file: string, args: string[]) => Promise<void>
  openPath: (path: string) => Promise<string>
}

const defaultDeps: OpenInEditorDeps = {
  resolve: resolveLaunch,
  exec: (file, args) =>
    new Promise<void>((done, reject) => {
      const child = execFile(file, args, { windowsHide: true }, (error) =>
        error ? reject(error) : done()
      )
      child.unref?.()
    }),
  openPath: (path) => shell.openPath(path)
}

/**
 * Open a directory in the user's editor: VS Code when its `code` CLI is on
 * PATH, otherwise the OS file manager. Callers must only pass engine-recorded
 * worktree paths — the renderer supplies task IDs, never filesystem paths.
 */
export async function openWorktreeInEditor(
  dir: string,
  deps: Partial<OpenInEditorDeps> = {}
): Promise<{ opened: 'editor' | 'folder' }> {
  const { resolve, exec, openPath } = { ...defaultDeps, ...deps }
  try {
    const launch = await resolve('code', [dir])
    await exec(launch.file, launch.args)
    return { opened: 'editor' }
  } catch {
    const failure = await openPath(dir)
    if (failure) throw new Error(`Ordner konnte nicht geöffnet werden: ${failure}`)
    return { opened: 'folder' }
  }
}
