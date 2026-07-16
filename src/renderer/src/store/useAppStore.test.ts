import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'
import { useAppStore } from '@renderer/store/useAppStore'

const initialState = useAppStore.getState()

function sourceProfile(): WorkspaceProfile {
  return workspaceProfileSchema.parse({
    id: 'source-profile',
    name: 'Source profile',
    workingDir: 'C:\\git\\source',
    agents: [
      {
        role: 'worker',
        provider: 'codex',
        model: 'gpt-codex',
        count: 2,
        orchestrated: true,
        yolo: true,
        strengths: ['Implementation'],
        weaknesses: []
      }
    ],
    yoloDefault: true,
    autoPr: { mode: 'off', strategy: 'aggregate' }
  })
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useAppStore profile duplication', () => {
  it('persists an independently edited duplicate without changing its source profile', async () => {
    const source = sourceProfile()
    let persistedProfiles = [structuredClone(source)]
    const saveProfile = vi.fn(async (profile: WorkspaceProfile) => {
      const savedProfile = workspaceProfileSchema.parse(structuredClone(profile))
      const savedIndex = persistedProfiles.findIndex((item) => item.id === savedProfile.id)
      persistedProfiles = savedIndex >= 0
        ? persistedProfiles.map((item, index) => index === savedIndex ? savedProfile : item)
        : [...persistedProfiles, savedProfile]
      return structuredClone(persistedProfiles)
    })
    const selectProfile = vi.fn(async () => true)

    vi.stubGlobal('window', { orca: { saveProfile } })
    useAppStore.setState({
      profiles: [source],
      activeProfileId: source.id,
      editorProfile: null,
      selectProfile,
      showToast: vi.fn()
    })

    await useAppStore.getState().duplicateProfile(source.id)

    const editorCopy = useAppStore.getState().editorProfile
    expect(editorCopy).not.toBeNull()
    if (!editorCopy) throw new Error('Duplicate was not opened in the editor.')

    const editedCopy: WorkspaceProfile = {
      ...editorCopy,
      name: 'Customized copy',
      autoPr: { ...editorCopy.autoPr, mode: 'draft-after-checks' }
    }
    await useAppStore.getState().saveEditor(editedCopy)

    const state = useAppStore.getState()
    const storedSource = state.profiles.find((profile) => profile.id === source.id)
    const storedCopy = state.profiles.find((profile) => profile.id === editedCopy.id)

    expect(saveProfile).toHaveBeenCalledTimes(2)
    expect(selectProfile).toHaveBeenCalledWith(editedCopy.id)
    expect(state.profiles).toHaveLength(2)
    expect(storedSource).toEqual(source)
    expect(storedSource).toMatchObject({
      id: source.id,
      name: source.name,
      agents: source.agents,
      autoPr: source.autoPr
    })
    expect(storedCopy).toMatchObject({
      id: editedCopy.id,
      name: 'Customized copy',
      autoPr: { mode: 'draft-after-checks' }
    })
    expect(storedCopy!.id).not.toBe(source.id)
  })
})
