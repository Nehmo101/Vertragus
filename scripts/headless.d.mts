/**
 * Typings for the pure, unit-tested helpers of scripts/headless.mjs
 * (consumed by src/main/headlessMode.test.ts; kept minimal on purpose).
 */
export declare const CONTROL_FILENAME: string

export interface HeadlessCliArgs {
  command?: 'start' | 'status' | 'pair' | 'help'
  userData?: string
  timeoutSec?: number
  error?: string
}

export declare function parseHeadlessCliArgs(argv: string[]): HeadlessCliArgs

export declare function parseControlAnnouncement(
  line: string
): { port: number; file: string } | undefined

export declare function candidateUserDataDirs(
  platform: NodeJS.Platform | string,
  env: Record<string, string | undefined>,
  home: string
): string[]

export declare function formatStatusReport(status: {
  enabled: boolean
  gatewayRunning: boolean
  gatewayPort?: number
  tunnel: string
  publicUrl?: string
  deviceCount: number
  error?: string
}): string[]

export declare function formatPairingReport(challenge: {
  code: string
  expiresAt: number
  pairingUrl?: string
}): string[]
