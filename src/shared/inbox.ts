/**
 * Ideas & artifacts inbox — shared types and validation.
 */
import { z } from 'zod'
import { ideaTransferSchema } from './inboxTransfer'

export const IDEA_STATUSES = ['draft', 'ready', 'archived', 'done'] as const
export type IdeaStatus = (typeof IDEA_STATUSES)[number]

/** Status values accepted from inbox create/update calls; archive transitions stay main-only. */
export const IDEA_INPUT_STATUSES = ['draft', 'ready', 'done'] as const
export type IdeaInputStatus = (typeof IDEA_INPUT_STATUSES)[number]

export const IDEA_HISTORY_KINDS = [
  'created',
  'statusChanged',
  'transferStarted',
  'transferUpdated',
  'archived',
  'restored',
  'attributeRemoved'
] as const

export const ideaHistoryEntrySchema = z.object({
  at: z.number(),
  kind: z.enum(IDEA_HISTORY_KINDS),
  detail: z.string().optional()
})

export type IdeaHistoryEntry = z.infer<typeof ideaHistoryEntrySchema>

export const REMOVABLE_IDEA_ATTRIBUTES = [
  'tags',
  'profileId',
  'workspaceId',
  'planId',
  'taskId'
] as const

export const removableIdeaAttributeSchema = z.enum(REMOVABLE_IDEA_ATTRIBUTES)
export type RemovableIdeaAttribute = z.infer<typeof removableIdeaAttributeSchema>
export type IdeaArchiveView = 'inbox' | 'archive'

export const ARTIFACT_KINDS = ['text', 'file', 'url', 'image'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** Image MIME types accepted for pasted/dropped image artifacts. */
export const IMAGE_ARTIFACT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
] as const
export type ImageArtifactMime = (typeof IMAGE_ARTIFACT_MIME_TYPES)[number]

/** Upper bound on a single decoded pasted image (guards against disk-fill / DoS). */
export const MAX_IMAGE_ARTIFACT_BYTES = 15 * 1024 * 1024

/** Server-side file extension for an accepted image MIME; null = unsupported. */
export function imageArtifactExtension(mime: string): string | null {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return null
  }
}

export const ideaRefsSchema = z.object({
  profileId: z.string().optional(),
  workspaceId: z.string().optional(),
  planId: z.string().optional(),
  taskId: z.string().optional()
})

export const ideaArtifactSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS),
  label: z.string(),
  createdAt: z.number(),
  text: z.string().optional(),
  sourcePath: z.string().optional(),
  storedPath: z.string().optional(),
  fileName: z.string().optional(),
  copied: z.boolean().optional(),
  url: z.string().optional(),
  missing: z.boolean().optional(),
  urlInvalid: z.boolean().optional(),
  /** Image MIME type for kind === 'image' artifacts. */
  mimeType: z.string().optional()
})

export const ideaSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  content: z.string(),
  status: z.enum(IDEA_STATUSES),
  tags: z.array(z.string()),
  refs: ideaRefsSchema.optional(),
  artifacts: z.array(ideaArtifactSchema),
  /** Latest inbox → workspace transfer state (stable transfer id per idea). */
  transfer: ideaTransferSchema.optional(),
  archivedAt: z.number().optional(),
  history: z.array(ideaHistoryEntrySchema).optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export type IdeaRefs = z.infer<typeof ideaRefsSchema>
export type IdeaArtifact = z.infer<typeof ideaArtifactSchema>
export type Idea = z.infer<typeof ideaSchema>

export type { IdeaTransfer, IdeaTransferRequest, IdeaTransferResult } from './inboxTransfer'

export interface CreateIdeaInput {
  title?: string
  content?: string
  status?: IdeaInputStatus
  tags?: string[]
  refs?: IdeaRefs
}

export interface UpdateIdeaInput {
  id: string
  title?: string
  content?: string
  status?: IdeaInputStatus
  tags?: string[]
  refs?: IdeaRefs
}

export interface AddTextArtifactInput {
  kind: 'text'
  label?: string
  text: string
}

export interface AddUrlArtifactInput {
  kind: 'url'
  label?: string
  url: string
}

export interface AddFileArtifactInput {
  kind: 'file'
  label?: string
  /** Short-lived grant from pickFile(); raw paths from renderer are rejected. */
  grantId: string
}

export interface AddImageArtifactInput {
  kind: 'image'
  label?: string
  /** Base64-encoded image bytes (no `data:` prefix). Validated + size-capped on the main side. */
  dataBase64: string
  /** image/* MIME type; checked against IMAGE_ARTIFACT_MIME_TYPES on the main side. */
  mimeType: string
  /** Original file/display name — used only as a label, never as a filesystem path. */
  name?: string
}

export type AddArtifactInput =
  | AddTextArtifactInput
  | AddUrlArtifactInput
  | AddFileArtifactInput
  | AddImageArtifactInput

/** Boundary schemas for the create/update/artifact IPC payloads (audit M5). */
export const createIdeaInputSchema = z.object({
  title: z.string().max(500).optional(),
  content: z.string().max(100_000).optional(),
  status: z.enum(IDEA_INPUT_STATUSES).optional(),
  tags: z.array(z.string().max(120)).max(64).optional(),
  refs: ideaRefsSchema.optional()
})

export const updateIdeaInputSchema = createIdeaInputSchema.extend({
  id: z.string().min(1).max(256)
})

export const addArtifactInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), label: z.string().max(300).optional(), text: z.string().max(200_000) }),
  z.object({ kind: z.literal('url'), label: z.string().max(300).optional(), url: z.string().max(2048) }),
  z.object({ kind: z.literal('file'), label: z.string().max(300).optional(), grantId: z.string().min(1).max(256) })
])

/** Accept http(s) URLs with a host. */
export function isValidUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const u = new URL(trimmed)
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname)
  } catch {
    return false
  }
}

export function normalizeTags(raw: string[] | string | undefined): string[] {
  if (!raw) return []
  const parts = Array.isArray(raw) ? raw : raw.split(',')
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const tag = part.trim().toLowerCase()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

export function enrichArtifact(artifact: IdeaArtifact, fileExists: (path: string) => boolean): IdeaArtifact {
  if (artifact.kind === 'url') {
    return { ...artifact, urlInvalid: !isValidUrl(artifact.url ?? '') }
  }
  if (artifact.kind === 'file') {
    const path = artifact.storedPath ?? artifact.sourcePath
    return { ...artifact, missing: !path || !fileExists(path) }
  }
  return artifact
}

export function enrichIdea(idea: Idea, fileExists: (path: string) => boolean): Idea {
  return {
    ...idea,
    artifacts: idea.artifacts.map((a) => enrichArtifact(a, fileExists))
  }
}
