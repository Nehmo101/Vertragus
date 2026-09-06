import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

interface Overlay { before?: string; after: string }
const overlays = new Map<string, Overlay>()

/** Remember exactly what attach injected; the working file stays usable by the CLI. */
export function writeProjectConfig(path: string, contents: string): void {
  let before: string | undefined
  try { before = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const previous = overlays.get(resolve(path))
  if (previous && before !== undefined) {
    try { before = cleanProjectConfig(path, before) }
    catch (error) { if (!(error instanceof SyntaxError)) throw error }
  }
  writeFileSync(path, contents)
  overlays.set(resolve(path), { before, after: contents })
}

function undoJson(before: unknown, after: unknown, current: unknown): unknown {
  if (JSON.stringify(before) === JSON.stringify(after)) return current
  if (JSON.stringify(current) === JSON.stringify(after)) return before
  if (after && current && typeof after === 'object' && typeof current === 'object' &&
      !Array.isArray(after) && !Array.isArray(current)) {
    const result = { ...current as Record<string, unknown> }
    const original = (before ?? {}) as Record<string, unknown>
    for (const key of Object.keys(after)) {
      const value = undoJson(original[key], (after as Record<string, unknown>)[key], result[key])
      if (value === undefined) delete result[key]
      else result[key] = value
    }
    return result
  }
  return current
}

/** Remove only unchanged host additions; retain edits to unrelated user settings. */
export function cleanProjectConfig(path: string, current: string): string | undefined {
  const overlay = overlays.get(resolve(path))
  if (!overlay) {
    if (/vertragus/.test(current) && /[?&]token=/.test(current)) {
      throw new Error('Snapshot refused: project MCP credentials have no known host overlay.')
    }
    return current
  }
  if (current === overlay.after) return overlay.before
  if (path.endsWith('.json')) {
    const cleaned = undoJson(overlay.before ? JSON.parse(overlay.before) : undefined,
      JSON.parse(overlay.after), JSON.parse(current))
    const serialized = JSON.stringify(cleaned, null, 2)
    // Fail closed if the agent moved or edited a host credential instead of its settings.
    assertNoHostTokens(overlay.after, serialized)
    return serialized
  }
  const sections = (text: string): string[] => text.split(/(?=^\[[^\n]+\])/m)
  const before = sections(overlay.before ?? '')
  let cleaned = current
  for (const section of sections(overlay.after)) {
    const header = section.match(/^\[[^\n]+\]/)?.[0]
    const original = header ? before.find((part) => part.startsWith(header)) : before[0]
    if (section !== original && cleaned.includes(section)) cleaned = cleaned.replace(section, original ?? '')
  }
  assertNoHostTokens(overlay.after, cleaned)
  return cleaned
}

function assertNoHostTokens(injected: string, cleaned: string): void {
  for (const token of injected.matchAll(/[?&]token=([^&\s"\\]+)/g)) {
    if (cleaned.includes(token[1]!)) throw new Error('Snapshot refused: host MCP credential remains in project configuration.')
  }
}

function applyJson(before: unknown, after: unknown, current: unknown): unknown {
  if (JSON.stringify(before) === JSON.stringify(after)) return current
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    const result = {...(current && typeof current === 'object' ? current : {})} as Record<string,unknown>
    const original = (before ?? {}) as Record<string,unknown>
    for (const [key,value] of Object.entries(after)) {
      result[key] = applyJson(original[key],value,result[key])
    }
    return result
  }
  return after
}

/** Temporarily expose the logical tracked config to git merge, then reattach to its result. */
export function suspendProjectConfig(path: string): (() => void) | undefined {
  const overlay = overlays.get(resolve(path))
  if (!overlay) return undefined
  let live: string
  try {live = readFileSync(path,'utf8')} catch {return undefined}
  const cleaned = cleanProjectConfig(path,live)
  if (cleaned === undefined || cleaned === live) return undefined
  writeFileSync(path,cleaned)
  return () => {
    let merged: string | undefined
    try { merged = readFileSync(path,'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let reattached = live
    if (merged !== cleaned && path.endsWith('.json')) {
      reattached = JSON.stringify(applyJson(overlay.before ? JSON.parse(overlay.before) : undefined,
        JSON.parse(overlay.after),merged ? JSON.parse(merged) : undefined),null,2)
    } else if (merged !== cleaned) {
      const sections = (text:string): string[] => text.split(/(?=^\[[^\n]+\])/m)
      reattached = merged ?? ''
      for (const section of sections(overlay.after)) {
        const header = section.match(/^\[[^\n]+\]/)?.[0]
        const original = sections(overlay.before ?? '').find((part)=>header ? part.startsWith(header) : !part.startsWith('['))
        if (section === original) continue
        const existing = sections(reattached).find((part)=>header ? part.startsWith(header) : !part.startsWith('['))
        reattached = existing ? reattached.replace(existing,section) : `${reattached}\n${section}`
      }
    }
    mkdirSync(dirname(path),{recursive:true})
    writeFileSync(path,reattached)
    overlays.set(resolve(path),{before:merged,after:reattached})
  }
}
