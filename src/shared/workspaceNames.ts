/**
 * Commedia place-names shared by the main and renderer processes for
 * labelling profile workspaces ("W1 Paradiso", "W2 Purgatorio", ...).
 *
 * The list is deliberately *durchgewürfelt*: Reiche, Flüsse, Sphären und
 * Städte — selig und verdammt, quer durch alle drei Reiche — are interleaved
 * so the sequence never feels monotone. Each entry carries a short `blurb` in
 * BOTH UI languages so the hover card follows the window's locale, mirroring
 * the agent code-names in `lore.ts`.
 *
 * Reference: Dante Alighieri, „La Divina Commedia" (1320, gemeinfrei).
 */
import type { BlurbLocale } from './lore'

export interface WorkspacePlace {
  name: string
  /** One-line tooltip per locale: what kind of place is this? */
  blurb: { de: string; en: string }
}

/** Curated, intentionally shuffled roster of Commedia locations. */
export const WORKSPACE_PLACES: readonly WorkspacePlace[] = [
  {
    name: 'Paradiso',
    blurb: {
      de: 'Das Paradies — die neun Himmelssphären bis hinauf zur Gottesschau.',
      en: 'Paradise — the nine heavenly spheres up to the vision of God.'
    }
  },
  {
    name: 'Purgatorio',
    blurb: {
      de: 'Der Läuterungsberg — sieben Terrassen der Reinigung mitten im Ozean.',
      en: 'Mount Purgatory — seven terraces of cleansing amid the ocean.'
    }
  },
  {
    name: 'Inferno',
    blurb: {
      de: 'Die Hölle — neun Kreise, trichterförmig bis zum Mittelpunkt der Erde.',
      en: 'Hell — nine circles, funnelling down to the centre of the earth.'
    }
  },
  {
    name: 'Limbo',
    blurb: {
      de: 'Erster Kreis: die tugendhaften Ungetauften — Sehnsucht ohne Qual.',
      en: 'First circle: the virtuous unbaptised — longing without torment.'
    }
  },
  {
    name: 'Selva Oscura',
    blurb: {
      de: 'Der dunkle Wald, in dem sich Dante zu Beginn der Reise verirrt.',
      en: 'The dark wood in which Dante loses his way at the journey\'s start.'
    }
  },
  {
    name: 'Empireo',
    blurb: {
      de: 'Der höchste Himmel jenseits von Raum und Zeit — reines Licht.',
      en: 'The highest heaven beyond space and time — pure light.'
    }
  },
  {
    name: 'Malebolge',
    blurb: {
      de: 'Achter Kreis: zehn steinerne Gräben für die Betrüger, mit Brücken verbunden.',
      en: 'Eighth circle: ten stone trenches for the fraudulent, joined by bridges.'
    }
  },
  {
    name: 'Eden',
    blurb: {
      de: 'Das irdische Paradies auf dem Gipfel des Läuterungsbergs.',
      en: 'The earthly paradise on the summit of Mount Purgatory.'
    }
  },
  {
    name: 'Acheronte',
    blurb: {
      de: 'Der erste Höllenfluss, über den Caronte die Seelen setzt.',
      en: 'The first river of Hell, across which Caronte ferries the souls.'
    }
  },
  {
    name: 'Sole',
    blurb: {
      de: 'Die Sonnensphäre, in der die Weisen als Lichterkränze tanzen.',
      en: 'The sphere of the Sun, where the wise dance as wreaths of light.'
    }
  },
  {
    name: 'Dite',
    blurb: {
      de: 'Die glühende Höllenstadt, die die tiefere Hölle ummauert.',
      en: 'The glowing city of Hell that walls in the deeper pit.'
    }
  },
  {
    name: 'Lete',
    blurb: {
      de: 'Fluss im Eden, der die Erinnerung an die Sünde löscht.',
      en: 'River in Eden that washes away the memory of sin.'
    }
  },
  {
    name: 'Giove',
    blurb: {
      de: 'Die Jupitersphäre, wo die Gerechten den sprechenden Adler formen.',
      en: 'The sphere of Jupiter, where the just form the speaking eagle.'
    }
  },
  {
    name: 'Cocito',
    blurb: {
      de: 'Der zugefrorene See am Grund der Hölle, in dem die Verräter stecken.',
      en: 'The frozen lake at the bottom of Hell, in which the traitors are stuck.'
    }
  },
  {
    name: 'Valletta',
    blurb: {
      de: 'Das Blumental der säumigen Fürsten im Antipurgatorio.',
      en: 'The flowering valley of the negligent princes in Antepurgatory.'
    }
  },
  {
    name: 'Stige',
    blurb: {
      de: 'Sumpffluss der Zornigen, den Flegias mit dem Kahn überquert.',
      en: 'Marsh river of the wrathful, crossed by Flegias in his skiff.'
    }
  },
  {
    name: 'Stelle Fisse',
    blurb: {
      de: 'Der Fixsternhimmel, in dem Dante über Glaube, Hoffnung und Liebe geprüft wird.',
      en: 'The Heaven of Fixed Stars, where Dante is examined on faith, hope and love.'
    }
  },
  {
    name: 'Antipurgatorio',
    blurb: {
      de: 'Die unteren Hänge des Läuterungsbergs, wo die spät Reuigen warten.',
      en: 'The lower slopes of Mount Purgatory, where the late repentant wait.'
    }
  },
  {
    name: 'Flegetonte',
    blurb: {
      de: 'Der kochende Blutstrom, bewacht von den Zentauren.',
      en: 'The boiling river of blood, guarded by the centaurs.'
    }
  },
  {
    name: 'Luna',
    blurb: {
      de: 'Die Mondsphäre der Unbeständigen — die erste Station des Aufstiegs.',
      en: 'The sphere of the Moon of the inconstant — the first station of the ascent.'
    }
  },
  {
    name: 'Caina',
    blurb: {
      de: 'Erste Zone des Eissees — benannt nach Kain, für Verräter an Verwandten.',
      en: 'First zone of the frozen lake — named after Cain, for traitors to their kin.'
    }
  },
  {
    name: 'Candida Rosa',
    blurb: {
      de: 'Die weiße Himmelsrose, in der die Seligen im Amphitheater thronen.',
      en: 'The white rose of Heaven, where the blessed sit enthroned in an amphitheatre.'
    }
  },
  {
    name: 'Vestibolo',
    blurb: {
      de: 'Die Vorhölle der Lauen, die weder gut noch böse sein wollten.',
      en: 'The vestibule of the lukewarm, who would be neither good nor evil.'
    }
  },
  {
    name: 'Mercurio',
    blurb: {
      de: 'Die Merkursphäre derer, die Gutes um des Ruhmes willen taten.',
      en: 'The sphere of Mercury of those who did good for glory\'s sake.'
    }
  },
  {
    name: 'Antenora',
    blurb: {
      de: 'Zweite Zone des Eissees — für Verräter an Stadt und Land.',
      en: 'Second zone of the frozen lake — for traitors to city and country.'
    }
  },
  {
    name: 'Eunoè',
    blurb: {
      de: 'Fluss im Eden, der die Erinnerung an das Gute zurückbringt.',
      en: 'River in Eden that brings back the memory of the good.'
    }
  },
  {
    name: 'Marte',
    blurb: {
      de: 'Die Marssphäre der Glaubenskämpfer, deren Seelen ein Kreuz bilden.',
      en: 'The sphere of Mars of the warriors of faith, whose souls form a cross.'
    }
  },
  {
    name: 'Tolomea',
    blurb: {
      de: 'Dritte Zone des Eissees — für Verräter an Gastfreunden.',
      en: 'Third zone of the frozen lake — for traitors to their guests.'
    }
  },
  {
    name: 'Venere',
    blurb: {
      de: 'Die Venussphäre der Liebenden.',
      en: 'The sphere of Venus of the lovers.'
    }
  },
  {
    name: 'Giudecca',
    blurb: {
      de: 'Innerste Zone des Eissees, wo Lucifero selbst im Eis steckt.',
      en: 'Innermost zone of the frozen lake, where Lucifero himself is stuck in the ice.'
    }
  },
  {
    name: 'Saturno',
    blurb: {
      de: 'Die Saturnsphäre der Kontemplativen mit der goldenen Himmelsleiter.',
      en: 'The sphere of Saturn of the contemplatives, with the golden heavenly ladder.'
    }
  },
  {
    name: 'Gerusalemme',
    blurb: {
      de: 'Die Stadt, unter der sich der Höllentrichter öffnet.',
      en: 'The city beneath which the funnel of Hell opens.'
    }
  },
  {
    name: 'Primo Mobile',
    blurb: {
      de: 'Die neunte Sphäre, die alle anderen bewegt — Ursprung von Zeit und Bewegung.',
      en: 'The ninth sphere that moves all the others — origin of time and motion.'
    }
  },
  {
    name: 'Firenze',
    blurb: {
      de: 'Dantes Heimatstadt, aus der er verbannt wurde — oft gescholten, nie vergessen.',
      en: 'Dante\'s home town, from which he was banished — often scolded, never forgotten.'
    }
  },
  {
    name: 'Scala d’Oro',
    blurb: {
      de: 'Die goldene Leiter, die aus der Saturnsphäre himmelwärts führt.',
      en: 'The golden ladder leading heavenward out of the sphere of Saturn.'
    }
  },
  {
    name: 'Arno',
    blurb: {
      de: 'Der Fluss von Florenz, den die Commedia so oft beklagt.',
      en: 'The river of Florence, so often lamented in the Commedia.'
    }
  },
  {
    name: 'Burella',
    blurb: {
      de: 'Der natürliche Gang, durch den Dante aus der Hölle zum Läuterungsberg klettert.',
      en: 'The natural passage through which Dante climbs out of Hell towards Mount Purgatory.'
    }
  },
  {
    name: 'Verona',
    blurb: {
      de: 'Erste Zuflucht des Verbannten — Hof der Scaliger.',
      en: 'The exile\'s first refuge — the court of the Scaligeri.'
    }
  },
  {
    name: 'Ravenna',
    blurb: {
      de: 'Die Stadt, in der Dante die Commedia vollendete.',
      en: 'The city in which Dante completed the Commedia.'
    }
  },
  {
    name: 'Lucca',
    blurb: {
      de: 'Stadt der Pechsieder-Bolgia — „hier hilft kein Beten".',
      en: 'City of the pitch-boilers’ bolgia — “here no praying helps”.'
    }
  }
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

const PLACE_LORE: ReadonlyMap<string, WorkspacePlace['blurb']> = new Map(
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
 * Look up the tooltip text for a workspace place-name in one UI language.
 * Handles the Roman-numeral cycle suffix (e.g. "Paradiso II" → Paradiso's
 * blurb) so repeated workspaces still resolve. Returns undefined for
 * custom/unknown names.
 */
export function workspacePlaceBlurb(name: string, locale: BlurbLocale): string | undefined {
  if (!name) return undefined
  const direct = PLACE_LORE.get(name)
  if (direct) return direct[locale]
  // Strip a trailing " <roman>" cycle suffix (only A–D, M, and (…) groupings).
  const base = name.replace(/\s+[MDCLXVI()]+$/, '')
  return PLACE_LORE.get(base)?.[locale]
}
