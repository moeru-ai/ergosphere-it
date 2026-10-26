import type { Logg } from '@guiiai/logg'

import { describe, expect, it } from 'vitest'

import { createPublishReporter, formatBytes, formatDuration } from './progress'

/** A logger that keeps the lines it gets. */
function recordingLogger() {
  const lines: string[] = []
  const logger = {
    log: (message: string) => lines.push(message),
    withFields: () => logger,
  } as unknown as Logg

  return { lines, logger }
}

describe('createPublishReporter', () => {
  it('prints a long upload every 5 seconds and when it ends, with the rate and the time left', () => {
    const { lines, logger } = recordingLogger()
    let now = 0
    const report = createPublishReporter(logger, { now: () => now })
    const MB = 1024 * 1024

    report({ bytes: 400 * MB, channel: 'dev', objects: 1489, releaseId: 7, type: 'release', version: '0.12.0+dev.45.1bf946f' })
    now = 6000
    report({ checked: 800, objects: 1489, type: 'checking' })
    now = 7000
    report({ checked: 1000, objects: 1489, type: 'checking' })
    report({ newBytes: 400 * MB, newObjects: 1480, skipped: 9, type: 'checked' })
    now = 9000
    report({ newBytes: 400 * MB, newObjects: 1480, type: 'uploading', uploadedBytes: 10 * MB, uploadedObjects: 40 })
    now = 17000
    report({ newBytes: 400 * MB, newObjects: 1480, type: 'uploading', uploadedBytes: 100 * MB, uploadedObjects: 370 })
    now = 19000
    report({ newBytes: 400 * MB, newObjects: 1480, type: 'uploading', uploadedBytes: 120 * MB, uploadedObjects: 444 })
    now = 47000
    report({ newBytes: 400 * MB, newObjects: 1480, type: 'uploading', uploadedBytes: 400 * MB, uploadedObjects: 1480 })
    report({ releaseId: 7, type: 'manifest' })
    report({ channel: 'dev', releaseId: 7, rollout: 100, type: 'channel' })

    expect(lines).toEqual([
      'Publishing bundle 7: 1489 objects, 400.0 MB. Checking which objects the store has.',
      'Checked 800/1489 objects.',
      'Uploading 1480 new objects, 400.0 MB. The store has the other 9.',
      'Uploaded 370/1480 objects, 100.0 MB of 400.0 MB (25%), 10.0 MB/s. About 30 s left.',
      'Uploaded 1480 objects, 400.0 MB, in 40 s.',
      'Uploaded the signed manifest of bundle 7.',
      'Channel dev now serves bundle 7 to 100% of installs. Published in 47 s.',
    ])
  })

  it('says when the store has every object', () => {
    const { lines, logger } = recordingLogger()
    const report = createPublishReporter(logger, { now: () => 0 })

    report({ newBytes: 0, newObjects: 0, skipped: 12, type: 'checked' })

    expect(lines).toEqual(['The store has all 12 objects. Nothing to upload.'])
  })
})

describe('formatBytes and formatDuration', () => {
  it.each([
    [912, '912 B'],
    [49_357, '48.2 KB'],
    [432_640_000, '412.6 MB'],
    [3 * 1024 ** 3, '3.00 GB'],
  ])('writes %i bytes as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })

  it.each([
    [850, '850 ms'],
    [42_000, '42 s'],
    [133_000, '2 min 13 s'],
  ])('writes %i ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
})
