export const INBOX_SORT_ORDERS = [
  'updated-desc',
  'updated-asc',
  'created-desc',
  'created-asc',
  'title-asc',
  'title-desc'
] as const

export type InboxSortOrder = (typeof INBOX_SORT_ORDERS)[number]

export interface SortableInboxItem {
  title: string
  createdAt: number
  updatedAt: number
}

function compareTimestamp(left: number, right: number, descending: boolean): number {
  const leftValid = Number.isFinite(left)
  const rightValid = Number.isFinite(right)
  if (!leftValid || !rightValid) {
    if (leftValid === rightValid) return 0
    return leftValid ? -1 : 1
  }
  return descending ? right - left : left - right
}

function compareTitle(left: string, right: string, descending: boolean): number {
  const comparison = left.trim().localeCompare(right.trim(), 'de', { sensitivity: 'base' })
  return descending ? -comparison : comparison
}

function compareInboxItems(
  left: SortableInboxItem,
  right: SortableInboxItem,
  order: InboxSortOrder
): number {
  switch (order) {
    case 'updated-desc':
      return compareTimestamp(left.updatedAt, right.updatedAt, true)
    case 'updated-asc':
      return compareTimestamp(left.updatedAt, right.updatedAt, false)
    case 'created-desc':
      return compareTimestamp(left.createdAt, right.createdAt, true)
    case 'created-asc':
      return compareTimestamp(left.createdAt, right.createdAt, false)
    case 'title-desc':
      return compareTitle(left.title, right.title, true)
    case 'title-asc':
      return compareTitle(left.title, right.title, false)
  }
}

/** Sorts inbox items stably and returns a new array. Invalid timestamps are placed last. */
export function sortInboxItems<T extends SortableInboxItem>(
  items: readonly T[],
  order: InboxSortOrder = 'updated-desc'
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      compareInboxItems(left.item, right.item, order) || left.index - right.index
    )
    .map(({ item }) => item)
}
