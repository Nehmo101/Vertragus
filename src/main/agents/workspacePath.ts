import { realpath } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

function stripWindowsPrefix(value: string): string {
  return value.replace(/^\\\\\?\\/, '')
}

/** Stable comparison key for aliases, slash variants and case-insensitive filesystems. */
export function workspacePathKey(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const absolute = isAbsolute(value) ? value : resolve(value)
  const normalized = stripWindowsPrefix(normalize(absolute)).replace(/[\\/]+$/, '')
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized
}

/** Resolve junctions, symlinks and Windows short paths before a workspace is dispatched. */
export async function canonicalWorkspacePath(value: string): Promise<string> {
  const absolute = isAbsolute(value) ? value : resolve(value)
  return stripWindowsPrefix(await realpath(absolute))
}

export async function sameWorkspacePath(left: string, right: string): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalWorkspacePath(left),
    canonicalWorkspacePath(right)
  ])
  return workspacePathKey(canonicalLeft) === workspacePathKey(canonicalRight)
}

export async function workspaceContains(root: string, candidate: string): Promise<boolean> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalWorkspacePath(root),
    canonicalWorkspacePath(candidate)
  ])
  const child = relative(canonicalRoot, canonicalCandidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}
