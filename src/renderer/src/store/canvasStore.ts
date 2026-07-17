/**
 * Persisted node positions for the workspace canvas, keyed per
 * profile + workspace session so every run keeps its own arrangement.
 * Mirrors the defensive localStorage pattern of `layoutStore.ts`.
 */
import { create } from 'zustand'
import type { NodePosition, NodePositions } from '@renderer/canvasGraph'

export const CANVAS_STORAGE_KEY = 'orca.canvas.v1'

type Boards = Record<string, NodePositions>

export interface CanvasStore {
  boards: Boards
  setPosition(boardKey: string, nodeId: string, position: NodePosition): void
}

export function canvasBoardKey(profileId: string, workspaceSessionId?: string): string {
  return `${profileId}::${workspaceSessionId ?? 'default'}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePosition(value: unknown): NodePosition | null {
  if (!isRecord(value)) return null
  const { x, y } = value
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

export function parsePersistedBoards(raw: string | null): Boards {
  if (raw === null) return {}
  try {
    const persisted: unknown = JSON.parse(raw)
    if (!isRecord(persisted) || !isRecord(persisted.boards)) return {}

    const boards: Boards = {}
    for (const [boardKey, nodes] of Object.entries(persisted.boards)) {
      if (!isRecord(nodes)) continue
      const positions: NodePositions = {}
      for (const [nodeId, position] of Object.entries(nodes)) {
        const parsed = parsePosition(position)
        if (parsed) positions[nodeId] = parsed
      }
      boards[boardKey] = positions
    }
    return boards
  } catch {
    return {}
  }
}

function getStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function loadBoards(): Boards {
  const storage = getStorage()
  if (!storage) return {}
  try {
    return parsePersistedBoards(storage.getItem(CANVAS_STORAGE_KEY))
  } catch {
    return {}
  }
}

function persistBoards(boards: Boards): void {
  try {
    getStorage()?.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ boards }))
  } catch {
    // Canvas persistence is best-effort; an unavailable storage must not break the renderer.
  }
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  boards: loadBoards(),
  setPosition: (boardKey, nodeId, position) => {
    set((state) => ({
      boards: {
        ...state.boards,
        [boardKey]: { ...state.boards[boardKey], [nodeId]: position }
      }
    }))
    persistBoards(get().boards)
  }
}))

const EMPTY_POSITIONS: NodePositions = {}

export const selectBoardPositions =
  (boardKey: string) =>
  (state: CanvasStore): NodePositions =>
    state.boards[boardKey] ?? EMPTY_POSITIONS
