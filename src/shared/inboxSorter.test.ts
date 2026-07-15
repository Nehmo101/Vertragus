import { describe, expect, it } from 'vitest'
import { sortInboxItems, type SortableInboxItem } from './inboxSorter'

interface TestItem extends SortableInboxItem {
  id: string
}

const items: TestItem[] = [
  { id: 'b', title: 'Beta', createdAt: 10, updatedAt: 20 },
  { id: 'a', title: 'Alpha', createdAt: 30, updatedAt: 40 },
  { id: 'c', title: 'Charlie', createdAt: 20, updatedAt: 30 }
]

describe('sortInboxItems', () => {
  it('sorts by latest update by default without mutating the input', () => {
    const original = [...items]

    expect(sortInboxItems(items).map(({ id }) => id)).toEqual(['a', 'c', 'b'])
    expect(items).toEqual(original)
  })

  it('supports creation time and title in both directions', () => {
    expect(sortInboxItems(items, 'created-asc').map(({ id }) => id)).toEqual(['b', 'c', 'a'])
    expect(sortInboxItems(items, 'created-desc').map(({ id }) => id)).toEqual(['a', 'c', 'b'])
    expect(sortInboxItems(items, 'title-asc').map(({ id }) => id)).toEqual(['a', 'b', 'c'])
    expect(sortInboxItems(items, 'title-desc').map(({ id }) => id)).toEqual(['c', 'b', 'a'])
  })

  it('keeps equal items stable and places invalid timestamps last', () => {
    const tied: TestItem[] = [
      { id: 'first', title: 'Same', createdAt: 1, updatedAt: 5 },
      { id: 'invalid', title: 'Invalid', createdAt: 2, updatedAt: Number.NaN },
      { id: 'second', title: 'Same', createdAt: 3, updatedAt: 5 }
    ]

    expect(sortInboxItems(tied).map(({ id }) => id)).toEqual(['first', 'second', 'invalid'])
    expect(sortInboxItems(tied, 'title-asc').map(({ id }) => id)).toEqual([
      'invalid',
      'first',
      'second'
    ])
  })
})
