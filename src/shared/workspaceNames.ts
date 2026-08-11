/**
 * Commedia place-names shared by the main and renderer processes for
 * labelling profile workspaces ("W1 Paradiso", "W2 Purgatorio", ...).
 *
 * The list is deliberately *durchgewürfelt*: Reiche, Flüsse, Sphären und
 * Städte — selig und verdammt, quer durch alle drei Reiche — are interleaved
 * so the sequence never feels monotone. Each entry carries a short German
 * `blurb` so the UI can reveal what kind of place it is on hover, mirroring
 * the agent code-names in `lore.ts`.
 *
 * Reference: Dante Alighieri, „La Divina Commedia" (1320, gemeinfrei).
 */
export interface WorkspacePlace {
  name: string
  /** One-line German tooltip: was für ein Ort ist das? */
  blurb: string
}

/** Curated, intentionally shuffled roster of Commedia locations. */
export const WORKSPACE_PLACES: readonly WorkspacePlace[] = [
  { name: 'Paradiso', blurb: 'Das Paradies — die neun Himmelssphären bis hinauf zur Gottesschau.' },
  { name: 'Purgatorio', blurb: 'Der Läuterungsberg — sieben Terrassen der Reinigung mitten im Ozean.' },
  { name: 'Inferno', blurb: 'Die Hölle — neun Kreise, trichterförmig bis zum Mittelpunkt der Erde.' },
  { name: 'Limbo', blurb: 'Erster Kreis: die tugendhaften Ungetauften — Sehnsucht ohne Qual.' },
  { name: 'Selva Oscura', blurb: 'Der dunkle Wald, in dem sich Dante zu Beginn der Reise verirrt.' },
  { name: 'Empireo', blurb: 'Der höchste Himmel jenseits von Raum und Zeit — reines Licht.' },
  { name: 'Malebolge', blurb: 'Achter Kreis: zehn steinerne Gräben für die Betrüger, mit Brücken verbunden.' },
  { name: 'Eden', blurb: 'Das irdische Paradies auf dem Gipfel des Läuterungsbergs.' },
  { name: 'Acheronte', blurb: 'Der erste Höllenfluss, über den Caronte die Seelen setzt.' },
  { name: 'Sole', blurb: 'Die Sonnensphäre, in der die Weisen als Lichterkränze tanzen.' },
  { name: 'Dite', blurb: 'Die glühende Höllenstadt, die die tiefere Hölle ummauert.' },
  { name: 'Lete', blurb: 'Fluss im Eden, der die Erinnerung an die Sünde löscht.' },
  { name: 'Giove', blurb: 'Die Jupitersphäre, wo die Gerechten den sprechenden Adler formen.' },
  { name: 'Cocito', blurb: 'Der zugefrorene See am Grund der Hölle, in dem die Verräter stecken.' },
  { name: 'Valletta', blurb: 'Das Blumental der säumigen Fürsten im Antipurgatorio.' },
  { name: 'Stige', blurb: 'Sumpffluss der Zornigen, den Flegias mit dem Kahn überquert.' },
  { name: 'Stelle Fisse', blurb: 'Der Fixsternhimmel, in dem Dante über Glaube, Hoffnung und Liebe geprüft wird.' },
  { name: 'Antipurgatorio', blurb: 'Die unteren Hänge des Läuterungsbergs, wo die spät Reuigen warten.' },
  { name: 'Flegetonte', blurb: 'Der kochende Blutstrom, bewacht von den Zentauren.' },
  { name: 'Luna', blurb: 'Die Mondsphäre der Unbeständigen — die erste Station des Aufstiegs.' },
  { name: 'Caina', blurb: 'Erste Zone des Eissees — benannt nach Kain, für Verräter an Verwandten.' },
  { name: 'Candida Rosa', blurb: 'Die weiße Himmelsrose, in der die Seligen im Amphitheater thronen.' },
  { name: 'Vestibolo', blurb: 'Die Vorhölle der Lauen, die weder gut noch böse sein wollten.' },
  { name: 'Mercurio', blurb: 'Die Merkursphäre derer, die Gutes um des Ruhmes willen taten.' },
  { name: 'Antenora', blurb: 'Zweite Zone des Eissees — für Verräter an Stadt und Land.' },
  { name: 'Eunoè', blurb: 'Fluss im Eden, der die Erinnerung an das Gute zurückbringt.' },
  { name: 'Marte', blurb: 'Die Marssphäre der Glaubenskämpfer, deren Seelen ein Kreuz bilden.' },
  { name: 'Tolomea', blurb: 'Dritte Zone des Eissees — für Verräter an Gastfreunden.' },
  { name: 'Venere', blurb: 'Die Venussphäre der Liebenden.' },
  { name: 'Giudecca', blurb: 'Innerste Zone des Eissees, wo Lucifero selbst im Eis steckt.' },
  { name: 'Saturno', blurb: 'Die Saturnsphäre der Kontemplativen mit der goldenen Himmelsleiter.' },
  { name: 'Gerusalemme', blurb: 'Die Stadt, unter der sich der Höllentrichter öffnet.' },
  { name: 'Primo Mobile', blurb: 'Die neunte Sphäre, die alle anderen bewegt — Ursprung von Zeit und Bewegung.' },
  { name: 'Firenze', blurb: 'Dantes Heimatstadt, aus der er verbannt wurde — oft gescholten, nie vergessen.' },
  { name: 'Scala d’Oro', blurb: 'Die goldene Leiter, die aus der Saturnsphäre himmelwärts führt.' },
  { name: 'Arno', blurb: 'Der Fluss von Florenz, den die Commedia so oft beklagt.' },
  { name: 'Burella', blurb: 'Der natürliche Gang, durch den Dante aus der Hölle zum Läuterungsberg klettert.' },
  { name: 'Verona', blurb: 'Erste Zuflucht des Verbannten — Hof der Scaliger.' },
  { name: 'Ravenna', blurb: 'Die Stadt, in der Dante die Commedia vollendete.' },
  { name: 'Lucca', blurb: 'Stadt der Pechsieder-Bolgia — „hier hilft kein Beten".' }
] as const

/** Just the ordered names — kept for backwards compatibility and the allocator. */
export const WORKSPACE_PLACE_NAMES = WORKSPACE_PLACES.map((place) => place.name)

/** Return a newly shuffled roster without mutating the curated source list. */
export function shuffleWorkspacePlaceNames(
  randomIndex: (maxExclusive: number) => number
): string[] {
  const names = [...WORKSPACE_PLACE_NAMES]
  for (let index = names.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1)
    if (!Number.isSafeInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new RangeError(`Random workspace-name index ${swapIndex} is outside 0..${index}.`)
    }
    ;[names[index], names[swapIndex]] = [names[swapIndex]!, names[index]!]
  }
  return names
}

const PLACE_LORE: ReadonlyMap<string, string> = new Map(
  WORKSPACE_PLACES.map((place) => [place.name, place.blurb])
)

const ROMAN_DIGITS: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I']
]

function romanBelow4000(value: number): string {
  let remainder = value
  let result = ''
  for (const [unit, numeral] of ROMAN_DIGITS) {
    while (remainder >= unit) {
      result += numeral
      remainder -= unit
    }
  }
  return result
}

/**
 * Parentheses multiply a Roman numeral by 1,000. This keeps even very large,
 * safe integer sequences compact instead of allocating an unbounded `M` run.
 */
function compactRoman(value: number): string {
  if (value < 4000) return romanBelow4000(value)
  const thousands = Math.floor(value / 1000)
  const remainder = value % 1000
  return `(${compactRoman(thousands)})${romanBelow4000(remainder)}`
}

/** Return the Commedia place at a sequence position in the supplied name order. */
export function workspacePlaceName(
  sequence: number,
  names: readonly string[] = WORKSPACE_PLACE_NAMES
): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return `Workspace ${sequence}`
  if (names.length === 0) return `Workspace ${sequence}`

  const index = (sequence - 1) % names.length
  const cycle = Math.floor((sequence - 1) / names.length) + 1
  const name = names[index]!
  return cycle === 1 ? name : `${name} ${compactRoman(cycle)}`
}

/**
 * Look up the tooltip text for a workspace place-name. Handles the Roman-numeral
 * cycle suffix (e.g. "Paradiso II" → Paradisos blurb) so repeated workspaces
 * still resolve. Returns undefined for custom/unknown names.
 */
export function workspacePlaceBlurb(name: string): string | undefined {
  if (!name) return undefined
  const direct = PLACE_LORE.get(name)
  if (direct) return direct
  // Strip a trailing " <roman>" cycle suffix (only A–D, M, and (…) groupings).
  const base = name.replace(/\s+[MDCLXVI()]+$/, '')
  return PLACE_LORE.get(base)
}
