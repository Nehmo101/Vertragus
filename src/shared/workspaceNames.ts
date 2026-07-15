/** Ordered workspace names shared by the main and renderer processes. */
export const MIDDLE_EARTH_WORKSPACE_NAMES = [
  'Minas Tirith',
  'Minas Morgul',
  'Amon Sûl',
  'Bruchtal',
  'Lothlórien',
  'Edoras',
  'Isengard',
  'Erebor',
  'Bree',
  'Osgiliath',
  'Helms Klamm',
  'Hobbingen',
  'Barad-dûr',
  'Dol Guldur',
  'Fangorn',
  'Moria',
  'Caras Galadhon',
  'Grauen Anfurten',
  'Düsterwald',
  'Rohan',
  'Gondor',
  'Cair Andros',
  'Henneth Annûn',
  'Orthanc'
] as const

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
