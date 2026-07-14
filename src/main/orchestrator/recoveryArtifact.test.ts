import { describe, expect, it } from 'vitest'
import { recoveryFilesFromStatus } from './recoveryArtifact'

describe('task recovery artifacts', () => {
  it('extracts modified, untracked and renamed files from porcelain status', () => {
    const status = [
      ' M src/main/worker.ts',
      '?? src/main/new-worker.test.ts',
      'R  src/old.ts -> src/new.ts',
      ' M src/main/worker.ts'
    ].join('\n')

    expect(recoveryFilesFromStatus(status)).toEqual([
      'src/main/worker.ts',
      'src/main/new-worker.test.ts',
      'src/new.ts'
    ])
  })
})
