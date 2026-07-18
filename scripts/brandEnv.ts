/**
 * Brand-neutral environment flags for repo scripts.
 * Canonical prefix is VERTRAGUS_*; legacy ORCA_* names remain as fallbacks
 * so existing CI jobs and local shells keep working.
 */
export function brandEnv(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env[`VERTRAGUS_${suffix}`] ?? env[`ORCA_${suffix}`]
}
