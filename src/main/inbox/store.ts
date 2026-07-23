/**
 * Ideas inbox persistence (electron-store) in the main process.
 */
import { randomUUID } from 'node:crypto'
import Store from 'electron-store'
import { app } from 'electron'
import {
  enrichIdea,
  ideaSchema,
  normalizeTags,
  isValidUrl,
  imageArtifactExtension,
  MAX_IMAGE_ARTIFACT_BYTES,
  type AddArtifactInput,
  type CreateIdeaInput,
  type Idea,
  type IdeaArtifact,
  type RemovableIdeaAttribute,
  type UpdateIdeaInput
} from '@shared/inbox'
import { fileExists, storeImageArtifact, tryCopyArtifactFile } from '@main/inbox/files'
import { consumePickerGrant } from '@main/inbox/pickerGrants'
import type { IdeaTransfer } from '@shared/inboxTransfer'
import {
  appendHistory,
  autoArchiveProcessed,
  removeIdeaAttribute as removeIdeaAttributeValue,
  restoreIdea as restoreIdeaValue,
  sortNewestFirst
} from '@main/inbox/archive'

import { adoptLegacyFile } from '@main/config/legacyAdoption'

interface InboxStoreShape {
  ideas: Idea[]
}

// Adopt the pre-rebrand inbox exactly once, before electron-store materializes
// vertragus-inbox.json with defaults (copy-only; orca-inbox.json stays).
try {
  adoptLegacyFile(app.getPath('userData'), 'orca-inbox.json', 'vertragus-inbox.json')
} catch {
  // Outside a real Electron runtime (vitest) `app` is undefined.
}

const store = new Store<InboxStoreShape>({
  name: 'vertragus-inbox',
  defaults: { ideas: [] }
})

function now(): number {
  return Date.now()
}

function assertRendererStatusAllowed(status: unknown): void {
  if (status === 'archived') {
    throw new Error('Archivierung ist nur ueber die Main-Archivoperation erlaubt.')
  }
}

function normalizeArchiveMetadata(idea: Idea): Idea {
  if (idea.status === 'archived') {
    return idea.archivedAt === undefined ? { ...idea, archivedAt: idea.updatedAt } : idea
  }
  if (idea.archivedAt === undefined) return idea

  const normalized = { ...idea }
  delete normalized.archivedAt
  return normalized
}

function parseIdeas(): Idea[] {
  return store.get('ideas').map((idea) => normalizeArchiveMetadata(ideaSchema.parse(idea)))
}

function saveIdeas(ideas: Idea[]): Idea[] {
  store.set('ideas', ideas)
  return ideas
}

function enrichAll(ideas: Idea[]): Idea[] {
  return ideas.map((idea) => enrichIdea(idea, fileExists))
}

export function listIdeas(): Idea[] {
  return enrichAll(sortNewestFirst(parseIdeas(), 'inbox'))
}

export function getIdea(id: string): Idea | undefined {
  const idea = parseIdeas().find((i) => i.id === id)
  return idea ? enrichIdea(idea, fileExists) : undefined
}

export function createIdea(input: CreateIdeaInput = {}): Idea {
  assertRendererStatusAllowed((input as { status?: unknown }).status)
  const ts = now()
  let idea: Idea = ideaSchema.parse({
    id: randomUUID(),
    title: input.title?.trim() || 'Neue Idee',
    content: input.content ?? '',
    status: input.status ?? 'draft',
    tags: normalizeTags(input.tags),
    refs: input.refs,
    artifacts: [],
    history: [{ at: ts, kind: 'created' }],
    createdAt: ts,
    updatedAt: ts
  })
  if (input.status === 'done') {
    idea = autoArchiveProcessed([idea], ts).ideas[0]
  }
  const ideas = parseIdeas()
  ideas.push(idea)
  saveIdeas(ideas)
  return enrichIdea(idea, fileExists)
}

export function updateIdea(input: UpdateIdeaInput): Idea {
  assertRendererStatusAllowed((input as { status?: unknown }).status)
  const ideas = parseIdeas()
  const idx = ideas.findIndex((i) => i.id === input.id)
  if (idx < 0) throw new Error('Idee nicht gefunden.')
  const current = ideas[idx]
  if (current.status === 'archived' && input.status !== undefined) {
    throw new Error('Archivierte Ideen koennen nur ueber die Main-Operation wiederhergestellt werden.')
  }
  const ts = now()
  const nextStatus = input.status ?? current.status
  let updated: Idea = ideaSchema.parse({
    ...current,
    title: input.title !== undefined ? input.title.trim() || 'Ohne Titel' : current.title,
    content: input.content !== undefined ? input.content : current.content,
    status: nextStatus,
    tags: input.tags !== undefined ? normalizeTags(input.tags) : current.tags,
    refs: input.refs !== undefined ? input.refs : current.refs,
    transfer: current.transfer,
    updatedAt: ts
  })

  if (nextStatus !== current.status) {
    updated = appendHistory(updated, {
      at: ts,
      kind: 'statusChanged',
      detail: `${current.status} -> ${nextStatus}`
    })
  }
  if (input.status === 'done') {
    updated = autoArchiveProcessed([updated], ts).ideas[0]
  }
  updated = ideaSchema.parse(updated)
  ideas[idx] = updated
  saveIdeas(ideas)
  return enrichIdea(updated, fileExists)
}

/** Main-process only: persist transfer state (never accepted from renderer IPC). */
export function applyIdeaTransfer(
  ideaId: string,
  transfer: IdeaTransfer,
  refs?: Idea['refs']
): Idea {
  const ideas = parseIdeas()
  const idx = ideas.findIndex((i) => i.id === ideaId)
  if (idx < 0) throw new Error('Idee nicht gefunden.')
  const current = ideas[idx]
  const ts = now()
  const updated: Idea = ideaSchema.parse(
    appendHistory(
      {
        ...current,
        refs: refs !== undefined ? refs : current.refs,
        transfer,
        updatedAt: ts
      },
      {
        at: ts,
        kind: current.transfer ? 'transferUpdated' : 'transferStarted',
        detail: transfer.status
      }
    )
  )
  ideas[idx] = updated
  saveIdeas(ideas)
  return enrichIdea(updated, fileExists)
}

/** Clear the handoff state while preserving the selected profile as a convenience. */
export function resetIdeaTransfer(ideaId: string): Idea {
  const ideas = parseIdeas()
  const idx = ideas.findIndex((idea) => idea.id === ideaId)
  if (idx < 0) throw new Error('Idee nicht gefunden.')
  const current = ideas[idx]
  const updated: Idea = ideaSchema.parse({
    ...current,
    refs: current.refs?.profileId ? { profileId: current.refs.profileId } : undefined,
    transfer: undefined,
    updatedAt: now()
  })
  ideas[idx] = updated
  saveIdeas(ideas)
  return enrichIdea(updated, fileExists)
}

export function removeIdeaAttribute(
  ideaId: string,
  attribute: RemovableIdeaAttribute
): Idea {
  const ideas = parseIdeas()
  const idx = ideas.findIndex((idea) => idea.id === ideaId)
  if (idx < 0) throw new Error('Idee nicht gefunden.')
  const candidate = removeIdeaAttributeValue(ideas[idx], attribute, now())
  if (candidate === ideas[idx]) return enrichIdea(ideas[idx], fileExists)

  const updated = ideaSchema.parse(candidate)
  ideas[idx] = updated
  saveIdeas(ideas)
  return enrichIdea(updated, fileExists)
}

export function restoreIdea(ideaId: string): Idea {
  const ideas = parseIdeas()
  const idx = ideas.findIndex((idea) => idea.id === ideaId)
  if (idx < 0) throw new Error('Idee nicht gefunden.')
  const updated = ideaSchema.parse(restoreIdeaValue(ideas[idx], now()))
  ideas[idx] = updated
  saveIdeas(ideas)
  return enrichIdea(updated, fileExists)
}

export function deleteIdea(id: string): Idea[] {
  const ideas = parseIdeas().filter((i) => i.id !== id)
  saveIdeas(ideas)
  return enrichAll(ideas)
}

export async function addArtifact(ideaId: string, input: AddArtifactInput): Promise<Idea> {
  const ideas = parseIdeas()
  const idx = ideas.findIndex((i) => i.id === ideaId)
  if (idx < 0) throw new Error('Idee nicht gefunden.')

  const artifact: IdeaArtifact = {
    id: randomUUID(),
    kind: input.kind,
    label: input.label?.trim() || defaultArtifactLabel(input),
    createdAt: now()
  }

  if (input.kind === 'text') {
    artifact.text = input.text
  } else if (input.kind === 'url') {
    if (!isValidUrl(input.url)) throw new Error('URL ist ungültig (http/https erforderlich).')
    artifact.url = input.url.trim()
  } else if (input.kind === 'image') {
    const extension = imageArtifactExtension(input.mimeType)
    if (!extension) throw new Error('Nicht unterstützter Bildtyp.')
    const clean = input.dataBase64.replace(/\s/g, '')
    if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
      throw new Error('Bilddaten ungültig (kein Base64).')
    }
    const data = Buffer.from(clean, 'base64')
    if (data.length === 0) throw new Error('Bilddaten sind leer.')
    if (data.length > MAX_IMAGE_ARTIFACT_BYTES) throw new Error('Bild ist zu groß (max. 15 MB).')
    const userData = app.getPath('userData')
    // Filename is server-generated from artifact.id + validated extension — client `name` is display-only.
    const stored = await storeImageArtifact(userData, ideaId, artifact.id, data, extension)
    artifact.storedPath = stored.storedPath
    artifact.fileName = artifact.label
    artifact.mimeType = input.mimeType
    artifact.copied = true
  } else {
    const sourcePath = consumePickerGrant(input.grantId)
    const userData = app.getPath('userData')
    const copy = await tryCopyArtifactFile(userData, ideaId, artifact.id, sourcePath)
    artifact.sourcePath = sourcePath
    artifact.fileName = copy.fileName
    artifact.copied = copy.copied
    if (copy.storedPath) artifact.storedPath = copy.storedPath
  }

  const current = ideas[idx]
  const updated: Idea = ideaSchema.parse({
    ...current,
    artifacts: [...current.artifacts, artifact],
    updatedAt: now()
  })
  ideas[idx] = updated
  saveIdeas(ideas)
  return enrichIdea(updated, fileExists)
}

export function removeArtifact(ideaId: string, artifactId: string): Idea {
  const ideas = parseIdeas()
  const idx = ideas.findIndex((i) => i.id === ideaId)
  if (idx < 0) throw new Error('Idee nicht gefunden.')
  const current = ideas[idx]
  const updated: Idea = ideaSchema.parse({
    ...current,
    artifacts: current.artifacts.filter((a) => a.id !== artifactId),
    updatedAt: now()
  })
  ideas[idx] = updated
  saveIdeas(ideas)
  return enrichIdea(updated, fileExists)
}

function defaultArtifactLabel(input: AddArtifactInput): string {
  if (input.kind === 'text') return 'Text'
  if (input.kind === 'url') return 'Link'
  if (input.kind === 'image') return input.name?.trim() || 'Bild'
  return input.label?.trim() || 'Datei'
}

/** Test hook: replace in-memory ideas without touching disk defaults. */
export function __resetIdeasForTest(ideas: Idea[]): void {
  saveIdeas(ideas.map((i) => ideaSchema.parse(i)))
}
