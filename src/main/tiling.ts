/**
 * Pure Fenster-Kachelung für den Rail-Start: verteilt N Agent-Pane-Fenster
 * sinnvoll über die freie Desktop-Arbeitsfläche (WorkArea minus Rail-Streifen).
 * Bewusst ohne Electron-Import — vollständig unit-testbar.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TileOptions {
  workArea: Rect
  /** Kante, an der die Rail angedockt ist; undefined = Rail auf anderem Display. */
  railEdge?: 'left' | 'right'
  railWidth: number
  count: number
  minW?: number
  minH?: number
  /** Index des Orchestrators — bekommt die erste Zelle (und Extra-Breite, wenn frei). */
  primaryIndex?: number
}

const GUTTER = 8
const DEFAULT_MIN_W = 420
const DEFAULT_MIN_H = 300
/** Versatz der Kaskade für Fenster jenseits der überlappungsfreien Kapazität. */
const CASCADE_OFFSET = 36

/** Arbeitsfläche abzüglich des Rail-Streifens (+ Gutter) auf der Rail-Kante. */
export function availableArea(
  workArea: Rect,
  railEdge: 'left' | 'right' | undefined,
  railWidth: number
): Rect {
  if (!railEdge || railWidth <= 0) return workArea
  const reserved = railWidth + GUTTER
  return {
    x: railEdge === 'left' ? workArea.x + reserved : workArea.x,
    y: workArea.y,
    width: Math.max(0, workArea.width - reserved),
    height: workArea.height
  }
}

/**
 * Raster für `count` Fenster: `cols ≈ sqrt(count·Seitenverhältnis)`, geklemmt,
 * sodass jede Zelle mindestens minW breit bleibt. Passen nicht alle Fenster
 * überlappungsfrei (Zellen würden unter minH fallen), werden die überzähligen
 * kaskadiert statt auf Null-Größen gequetscht. Der Orchestrator (primaryIndex)
 * bekommt die erste Zelle; bleibt in der letzten Reihe eine Zelle frei, wird
 * seine Zelle doppelt breit.
 */
export function computeTiles(options: TileOptions): Rect[] {
  const minW = options.minW ?? DEFAULT_MIN_W
  const minH = options.minH ?? DEFAULT_MIN_H
  const area = availableArea(options.workArea, options.railEdge, options.railWidth)
  if (options.count <= 0) return []

  // Überlappungsfreie Kapazität des Bereichs.
  const maxCols = Math.max(1, Math.floor(area.width / minW))
  const maxRows = Math.max(1, Math.floor(area.height / minH))
  const capacity = maxCols * maxRows
  const tiled = Math.min(options.count, capacity)

  const aspect = area.height > 0 ? area.width / area.height : 1
  let cols = Math.max(1, Math.min(maxCols, Math.round(Math.sqrt(tiled * aspect)) || 1))
  // Zellbreite ≥ minW: Spalten reduzieren, bis es passt (oder cols = 1).
  while (cols > 1 && area.width / cols < minW) cols -= 1
  const rows = Math.max(1, Math.ceil(tiled / cols))

  const cellW = Math.floor((area.width - GUTTER * (cols - 1)) / cols)
  const cellH = Math.floor((area.height - GUTTER * (rows - 1)) / rows)

  const primary = Math.min(Math.max(options.primaryIndex ?? 0, 0), options.count - 1)
  // Zellen in Leserichtung; der Orchestrator tauscht auf Zelle 0.
  const cellFor = (slot: number): Rect => {
    const row = Math.floor(slot / cols)
    const col = slot % cols
    return {
      x: area.x + col * (cellW + GUTTER),
      y: area.y + row * (cellH + GUTTER),
      width: cellW,
      height: cellH
    }
  }

  // Einreihig mit freier Zelle: der Orchestrator wird doppelt breit und die
  // übrigen Fenster rücken einen Slot weiter (die freie Zelle wird verbraucht).
  const spareInLastRow = rows * cols - tiled
  const primaryTiled = primary < tiled
  const primaryWide = primaryTiled && spareInLastRow > 0 && cols > 1 && rows === 1

  const tiles: Rect[] = []
  for (let index = 0; index < options.count; index += 1) {
    if (index >= tiled) {
      // Kaskade für Fenster jenseits der Kapazität — nie Null-Größen.
      const step = index - tiled + 1
      tiles.push({
        x: area.x + Math.min(step * CASCADE_OFFSET, Math.max(0, area.width - minW)),
        y: area.y + Math.min(step * CASCADE_OFFSET, Math.max(0, area.height - minH)),
        width: Math.min(minW, area.width) || minW,
        height: Math.min(minH, area.height) || minH
      })
      continue
    }
    if (index === primary && primaryTiled) {
      const cell = cellFor(0)
      tiles.push(primaryWide ? { ...cell, width: cellW * 2 + GUTTER } : cell)
      continue
    }
    // Slot-Zuordnung: alle vor dem Primary rutschen eins nach hinten; belegt
    // der Primary zwei Zellen, rücken alle einen weiteren Slot auf. Ein
    // kaskadierter Primary (jenseits der Kapazität) verschiebt niemanden.
    const slot = (primaryTiled && index < primary ? index + 1 : index) + (primaryWide ? 1 : 0)
    tiles.push(cellFor(slot))
  }
  return tiles
}

/**
 * Snap-Position der Rail: klemmt y in die WorkArea und schnappt x an die
 * linke/rechte Kante, sobald der Abstand unter dem Schwellwert liegt.
 */
export function snapRailPosition(
  x: number,
  y: number,
  workArea: Rect,
  railWidth: number,
  railHeight: number,
  threshold = 24
): { x: number; y: number; edge: 'left' | 'right' | null } {
  const leftX = workArea.x
  const rightX = workArea.x + workArea.width - railWidth
  const clampedY = Math.min(Math.max(y, workArea.y), workArea.y + Math.max(0, workArea.height - railHeight))
  if (Math.abs(x - leftX) <= threshold) return { x: leftX, y: clampedY, edge: 'left' }
  if (Math.abs(x - rightX) <= threshold) return { x: rightX, y: clampedY, edge: 'right' }
  const clampedX = Math.min(Math.max(x, leftX), rightX)
  return { x: clampedX, y: clampedY, edge: null }
}
