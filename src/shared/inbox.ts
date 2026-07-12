/**
 * Ideas & artifacts inbox — shared types and validation.
 */
import { z } from 'zod'
import { ideaTransferSchema } from './inboxTransfer'

export const IDEA_STATUSES = ['draft', 'ready', 'archived', 'done'] as const
export type IdeaStatus = (typeof IDEA_STATUSES)[number]

export const ARTIFACT_KINDS = ['text', 'file', 'url'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

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
  urlInvalid: z.boolean().optional()
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
  status?: IdeaStatus
  tags?: string[]
  refs?: IdeaRefs
}

export interface UpdateIdeaInput {
  id: string
  title?: string
  content?: string
  status?: IdeaStatus
  tags?: string[]
  refs?: IdeaRefs
  transfer?: import('./inboxTransfer').IdeaTransfer
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
  sourcePath: string
}

export type AddArtifactInput = AddTextArtifactInput | AddUrlArtifactInput | AddFileArtifactInput

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
