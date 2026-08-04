import { describe, expect, it } from 'vitest'
import { railTiles } from './railTiles'

const profiles = [
  { id: 'uwe', name: 'UWE' },
  { id: 'terra', name: 'terra art' },
  { id: 'empty', name: '' }
]

describe('railTiles', () => {
  it('derives one tile per profile with initial, running count and active flag', () => {
    const tiles = railTiles(
      profiles,
      [
        { profileId: 'uwe', status: 'running' },
        { profileId: 'uwe', status: 'running' },
        { profileId: 'uwe', status: 'stopped' },
        { profileId: 'terra', status: 'error' }
      ],
      [
        { profileId: 'uwe', active: true },
        { profileId: 'terra', active: false }
      ]
    )
    expect(tiles).toEqual([
      { id: 'uwe', name: 'UWE', initial: 'U', runningAgents: 2, active: true },
      { id: 'terra', name: 'terra art', initial: 'T', runningAgents: 0, active: false },
      { id: 'empty', name: '', initial: '?', runningAgents: 0, active: false }
    ])
  })

  it('shows no active glow for a session without running agents (failed start)', () => {
    const tiles = railTiles(profiles, [], [{ profileId: 'uwe', active: true }])
    expect(tiles[0]).toMatchObject({ id: 'uwe', runningAgents: 0, active: false })
  })

  it('keeps the profile order stable', () => {
    const tiles = railTiles(profiles, [], [])
    expect(tiles.map((tile) => tile.id)).toEqual(['uwe', 'terra', 'empty'])
  })
})
