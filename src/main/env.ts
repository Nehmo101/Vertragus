/**
 * Brand-neutral environment flags: after the Vertragus rebrand the
 * canonical prefix is VERTRAGUS_*, while the legacy ORCA_* names keep
 * working (CI scripts, user setups). New flags should only be read
 * through this helper.
 */
export function brandEnv(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env[`VERTRAGUS_${suffix}`] ?? env[`ORCA_${suffix}`]
}
