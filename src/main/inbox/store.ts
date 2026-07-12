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
  type AddArtifactInput,
  type CreateIdeaInput,
  type Idea,
  type IdeaArtifact,
  type UpdateIdeaInput
} from '@shared/inbox'
import { fileExists, tryCopyArtifactFile } from '@main/inbox/files'

interface InboxStoreShape {
  ideas: Idea[]
}

const store = new Store<InboxStoreShape>({
  name: 'orca-inbox',
  defaults: { ideas: [] }
})

function now(): number {
  return Date.now()
}

function parseIdeas(): Idea[] {
  return store.get('ideas').map((idea) => ideaSchema.parse(idea))
}

function saveIdeas(ideas: Idea[]): Idea[] {
  store.set('ideas', ideas)
  return ideas
}

function enrichAll(ideas: Idea[]): Idea[] {
  return ideas.map((idea) => enrichIdea(idea, fileExists))
}

export function listIdeas(): Idea[] {
  return enrichAll(parseIdeas().sort((a, b) => b.updatedAt - a.updatedAt))
}

export function getIdea(id: string): Idea | undefined {
  const idea = parseIdeas().find((i) => i.id === id)
  return idea ? enrichIdea(idea, fileExists) : undefined
}

export function createIdea(input: CreateIdeaInput = {}): Idea {
  const ts = now()
  const idea: Idea = ideaSchema.parse({
    id: randomUUID(),
    title: input.title?.trim() || 'Neue Idee',
    content: input.content ?? '',
    status: input.status ?? 'draft',
    tags: normalizeTags(input.tags),
    refs: input.refs,
    artifacts: [],
    createdAt: ts,
    updatedAt: ts
  })
  const ideas = parseIdeas()
  ideas.push(idea)
  saveIdeas(ideas)
  return enrichIdea(idea, fileExists)
}

export function updateIdea(input: UpdateIdeaInput): Idea {
  const ideas = parseIdeas()
  const idx = ideas.findIndex((i) => i.id === input.id)
  if (idx < 0) throw new Error('Idee nicht gefunden.')
  const current = ideas[idx]
  const updated: Idea = ideaSchema.parse({
    ...current,
    title: input.title !== undefined ? input.title.trim() || 'Ohne Titel' : current.title,
    content: input.content !== undefined ? input.content : current.content,
    status: input.status ?? current.status,
    tags: input.tags !== undefined ? normalizeTags(input.tags) : current.tags,
    refs: input.refs !== undefined ? input.refs : current.refs,
    updatedAt: now()
  })
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
  } else {
    const userData = app.getPath('userData')
    const copy = await tryCopyArtifactFile(userData, ideaId, artifact.id, input.sourcePath)
    artifact.sourcePath = input.sourcePath
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
  return input.sourcePath.split(/[/\\]/).pop() || 'Datei'
}

/** Test hook: replace in-memory ideas without touching disk defaults. */
export function __resetIdeasForTest(ideas: Idea[]): void {
  saveIdeas(ideas.map((i) => ideaSchema.parse(i)))
}
