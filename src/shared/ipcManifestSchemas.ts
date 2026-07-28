/**
 * Zod schema bindings for every manifest entry with `validation: 'schema'`.
 *
 * Kept separate from ipcManifest.ts on purpose: the manifest is imported by the
 * preload bundle, which stays zod-free; only the main process imports this
 * module (src/main/ipc/register.ts) and runs the central parse via
 * parseIpcPayload. The mapped type below fails to compile when a
 * schema-validated manifest entry has no binding here (or vice versa), and when
 * a schema's output type does not match the renderer argument it validates.
 */
import type { z } from 'zod'
import {
  bulkHandoffRequestSchema,
  githubIssueListRequestSchema,
  githubRepoBindRequestSchema,
  handoffRequestSchema,
  inboxSpeechSettingsPatchSchema,
  spawnAgentRequestSchema
} from './ipcSchemas'
import { mcpServersSchema } from './mcp'
import {
  addArtifactInputSchema,
  createIdeaInputSchema,
  updateIdeaInputSchema
} from './inbox'
import { ideaTransferRequestSchema } from './inboxTransfer'
import type { IpcManifest, IpcManifestKey, ManifestApiOf } from './ipcManifest'

/** Manifest keys that declare central schema validation. */
export type SchemaValidatedKey = {
  [K in IpcManifestKey]: IpcManifest[K] extends { validation: 'schema' } ? K : never
}[IpcManifestKey]

type AnyFn = (...args: never[]) => unknown
type ArgsOf<F> = F extends (...args: infer A) => unknown ? A : never
/**
 * The renderer argument types of the channel (union). The schema output must be
 * assignable to one of them — this pins schema ↔ VertragusApi type alignment.
 */
type PayloadOf<K extends SchemaValidatedKey> =
  ManifestApiOf<K> extends AnyFn ? ArgsOf<ManifestApiOf<K>>[number] : never

export interface ManifestSchemaBinding<K extends SchemaValidatedKey = SchemaValidatedKey> {
  /** German payload label used in parse error messages (parseIpcPayload). */
  label: string
  schema: z.ZodType<PayloadOf<K>, z.ZodTypeDef, unknown>
}

export const ipcManifestSchemas: { [K in SchemaValidatedKey]: ManifestSchemaBinding<K> } = {
  mcpSave: { label: 'MCP-Server-Liste', schema: mcpServersSchema },
  githubRepoBind: { label: 'Repository-Bindung', schema: githubRepoBindRequestSchema },
  githubListIssues: { label: 'Issue-Anfrage', schema: githubIssueListRequestSchema },
  ideasCreate: { label: 'Ideen-Eingabe', schema: createIdeaInputSchema },
  ideasUpdate: { label: 'Ideen-Aktualisierung', schema: updateIdeaInputSchema },
  ideasAddArtifact: { label: 'Artefakt-Eingabe', schema: addArtifactInputSchema },
  ideasTransferToProfile: { label: 'Transfer-Anfrage', schema: ideaTransferRequestSchema },
  inboxSpeechSetSettings: { label: 'Speech-Einstellungen', schema: inboxSpeechSettingsPatchSchema },
  agentSpawn: { label: 'Agent-Startanfrage', schema: spawnAgentRequestSchema },
  agentHandoff: { label: 'Übergabe-Anfrage', schema: handoffRequestSchema },
  agentsBulkHandoff: { label: 'Massenübergabe-Anfrage', schema: bulkHandoffRequestSchema }
}
