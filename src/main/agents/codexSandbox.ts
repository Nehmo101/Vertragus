/**
 * Keep native Windows Codex workspace-write runs on one writable root.
 *
 * The unelevated restricted-token sandbox cannot represent the legacy
 * workspace-write root plus separate TEMP and /tmp roots. Pointing every temp
 * variable into the worker worktree and excluding the synthetic /tmp root
 * preserves sandboxing without falling back to Yolo/full access.
 */
export const CODEX_RUNTIME_DIR_NAME = '.vertragus-runtime'

export const CODEX_WINDOWS_SINGLE_ROOT_CONFIG =
  'sandbox_workspace_write.exclude_slash_tmp=true'

export function codexSingleRootSandboxArgs(
  platform: NodeJS.Platform = process.platform
): string[] {
  return platform === 'win32' ? ['-c', CODEX_WINDOWS_SINGLE_ROOT_CONFIG] : []
}

export function codexSingleRootEnvironment(
  runtimeDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...environment }
  return {
    ...environment,
    TEMP: runtimeDir,
    TMP: runtimeDir,
    TMPDIR: runtimeDir
  }
}
