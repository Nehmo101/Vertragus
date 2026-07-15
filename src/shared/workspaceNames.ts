/**
 * Middle-earth place-names shared by the main and renderer processes for
 * labelling profile workspaces ("W1 Minas Tirith", "W2 Düsterwald", ...).
 *
 * The list is deliberately *durchgewürfelt*: regions, cities, fortresses and
 * natural landmarks — good and evil, across every age — are interleaved so the
 * sequence never feels monotone. Each entry carries a short German `blurb` so
 * the UI can reveal what kind of place it is on hover, mirroring the agent
 * code-names in `tolkien.ts`.
 *
 * Reference: https://de.wikipedia.org/wiki/Regionen_und_Orte_in_Tolkiens_Welt
 */
export interface MiddleEarthPlace {
  name: string
  /** One-line German tooltip: was für ein Ort ist das? */
  blurb: string
}

/** Curated, intentionally shuffled roster of Middle-earth locations. */
export const MIDDLE_EARTH_WORKSPACES: readonly MiddleEarthPlace[] = [
  { name: 'Minas Tirith', blurb: 'Die weiße Stadt — Hauptstadt Gondors, gestaffelt am Fuß des Mindolluin.' },
  { name: 'Düsterwald', blurb: 'Riesiger, verdunkelter Wald im Norden, Heimat der Waldelben (Mirkwood).' },
  { name: 'Hobbingen', blurb: 'Beschauliches Hobbitdorf im Auenland, Heimat von Bilbo und Frodo.' },
  { name: 'Barad-dûr', blurb: 'Saurons finsterer Dunkler Turm, gewaltige Festung im Herzen Mordors.' },
  { name: 'Bruchtal', blurb: 'Verborgenes Elbenrefugium Elronds in einem Tal Eriadors (Imladris).' },
  { name: 'Erebor', blurb: 'Der Einsame Berg — Zwergenreich, das der Drache Smaug einst raubte.' },
  { name: 'Rohan', blurb: 'Königreich des Reitervolks in weiten Graslandschaften (die Riddermark).' },
  { name: 'Moria', blurb: 'Uraltes, tiefes Zwergenreich Khazad-dûm unter dem Nebelgebirge.' },
  { name: 'Amon Sûl', blurb: 'Die Wetterspitze — alte Turmruine auf den Hügeln Eriadors (Weathertop).' },
  { name: 'Lothlórien', blurb: 'Goldenes Elbenreich Galadriels mit den silbernen Mallorn-Bäumen.' },
  { name: 'Isengard', blurb: 'Sarumans Festungsring rund um den unbezwingbaren Turm Orthanc.' },
  { name: 'Osgiliath', blurb: 'Alte, zerfallene Hauptstadt Gondors zu beiden Ufern des Anduin.' },
  { name: 'Auenland', blurb: 'Grüne, friedliche Heimat der Hobbits im Nordwesten (The Shire).' },
  { name: 'Minas Morgul', blurb: 'Die Totenstadt — einst Minas Ithil, nun Sitz des Hexenkönigs.' },
  { name: 'Helms Klamm', blurb: 'Uneinnehmbare Bergfestung Rohans mit der Hornburg.' },
  { name: 'Fangorn', blurb: 'Uralter, geheimnisvoller Wald, Heimat der Ents und Baumbarts.' },
  { name: 'Grauen Anfurten', blurb: 'Elbenhäfen im Westen, von denen die Schiffe nach Valinor segeln (Mithlond).' },
  { name: 'Gondolin', blurb: 'Verborgene Elbenstadt Beleriands, von Morgoth durch Verrat zerstört.' },
  { name: 'Edoras', blurb: 'Hügelstadt Rohans mit der goldenen Halle Meduseld.' },
  { name: 'Mordor', blurb: 'Saurons schwarzes Land hinter den Aschebergen im Südosten.' },
  { name: 'Bree', blurb: 'Menschen- und Hobbitdorf am Kreuzweg, Heimat des Gasthauses „Zum Tänzelnden Pony".' },
  { name: 'Nebelgebirge', blurb: 'Mächtige Bergkette, die Mittelerde von Norden nach Süden teilt (Hithaeglir).' },
  { name: 'Dol Guldur', blurb: 'Saurons finstere Festung im Süden des Düsterwalds.' },
  { name: 'Henneth Annûn', blurb: 'Verstecktes Refugium Faramirs hinter einem Wasserfall in Ithilien.' },
  { name: 'Schicksalsberg', blurb: 'Feuerspeiender Orodruin, an dem der Eine Ring geschmiedet wurde (Mount Doom).' },
  { name: 'Caras Galadhon', blurb: 'Baumstadt im Herzen Lothlóriens, Sitz Galadriels und Celeborns.' },
  { name: 'Thal', blurb: 'Menschenstadt am Fuß des Erebor, von Smaug verwüstet (Dale).' },
  { name: 'Doriath', blurb: 'Verborgenes Waldreich Thingols, geschützt durch Melians Gürtel.' },
  { name: 'Cair Andros', blurb: 'Befestigte Flussinsel im Anduin, nördlicher Vorposten Gondors.' },
  { name: 'Orthanc', blurb: 'Unzerstörbarer schwarzer Turm im Herzen von Isengard.' },
  { name: 'Númenor', blurb: 'Untergegangenes Inselreich der Menschen im Westen (das Atlantis Mittelerdes).' },
  { name: 'Esgaroth', blurb: 'Seestadt auf Pfählen im Langen See unterhalb des Erebor (Lake-town).' },
  { name: 'Angband', blurb: 'Morgoths gewaltige Höllenfestung im Norden Beleriands.' },
  { name: 'Emyn Muil', blurb: 'Zerklüftetes, ödes Felsenhügelland südlich des Nebelgebirges.' },
  { name: 'Cirith Ungol', blurb: 'Finsterer Passturm am Rand Mordors, Kankras Lauer.' },
  { name: 'Valinor', blurb: 'Segensreiches Land der Valar im unsterblichen Westen (Aman).' },
  { name: 'Totensümpfe', blurb: 'Trügerisches Moor voller Geister gefallener Krieger (Dead Marshes).' },
  { name: 'Fornost', blurb: 'Verlassene Königsstadt des einstigen Nordreichs Arnor.' },
  { name: 'Dunharg', blurb: 'In den Fels gehauene Zuflucht Rohans am Pfad der Toten (Dunharrow).' },
  { name: 'Carn Dûm', blurb: 'Festung des Hexenkönigs im eisigen Nordreich Angmar.' }
] as const

/** Just the ordered names — kept for backwards compatibility and the allocator. */
export const MIDDLE_EARTH_WORKSPACE_NAMES = MIDDLE_EARTH_WORKSPACES.map(
  (place) => place.name
)

const PLACE_LORE: ReadonlyMap<string, string> = new Map(
  MIDDLE_EARTH_WORKSPACES.map((place) => [place.name, place.blurb])
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

/** Return the deterministic Middle-earth place assigned to a workspace sequence. */
export function middleEarthWorkspaceName(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return `Workspace ${sequence}`

  const index = (sequence - 1) % MIDDLE_EARTH_WORKSPACE_NAMES.length
  const cycle = Math.floor((sequence - 1) / MIDDLE_EARTH_WORKSPACE_NAMES.length) + 1
  const name = MIDDLE_EARTH_WORKSPACE_NAMES[index]!
  return cycle === 1 ? name : `${name} ${compactRoman(cycle)}`
}

/**
 * Look up the tooltip text for a workspace place-name. Handles the Roman-numeral
 * cycle suffix (e.g. "Minas Tirith II" → Minas Tiriths blurb) so repeated
 * workspaces still resolve. Returns undefined for custom/unknown names.
 */
export function middleEarthWorkspaceBlurb(name: string): string | undefined {
  if (!name) return undefined
  const direct = PLACE_LORE.get(name)
  if (direct) return direct
  // Strip a trailing " <roman>" cycle suffix (only A–D, M, and (…) groupings).
  const base = name.replace(/\s+[MDCLXVI()]+$/, '')
  return PLACE_LORE.get(base)
}
