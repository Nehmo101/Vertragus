/**
 * Stable public facade for the four-part retro analysis subsystem.
 *
 * Consumers keep importing `@shared/retro`; the implementation modules remain
 * independently testable and free to evolve behind this boundary.
 */
export * from './retro/contracts'
export * from './retro/learnings'
export * from './retro/runAnalysis'
export * from './retro/benchmarkAnalysis'
