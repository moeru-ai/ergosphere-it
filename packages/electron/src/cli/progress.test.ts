import type { Logg } from '@guiiai/logg'

import { describe, expect, it } from 'vitest'

import { createPublishReporter, formatBytes, formatDuration } from './progress'

/** A logger that keeps each line as its level, message, and fields. */
function recordingLogger() {
  const lines: { fields: Record<string, unknown>, level: 'error' | 'log', message: string }[] = []
  const withFields = (fields: Record<string, unknown>): Logg => ({
    error: (message: string) => lines.push({ fields, level: 'error', message }),
    log: (message: string) => lines.push({ fields, level: 'log', message }),
    withFields: (more: Record<string, unknown>) => withFields({ ...fields, ...more }),
  }) as unknown as Logg

  return { lines, logger: withFields({}) }
}

const MB = 1024 * 1024

describe('createPublishReporter', () => {
  it('prints the steps of a long upload, and its progress every 5 seconds with the rate and the time left', () => {
    const { lines, logger } = recordingLogger()
    let now = 0
    const report = createPublishReporter(logger, { now: () => now })

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

    expect(lines.map(line => [line.message, line.fields])).toEqual([
      ['Publishing the bundle', { channel: 'dev', objects: 1489, releaseId: 7, size: '400.0 MB', version: '0.12.0+dev.45.1bf946f' }],
      ['Checking objects', { checked: '800/1489' }],
      ['Checked the store', { inStore: 9, newObjects: 1480, newSize: '400.0 MB' }],
      ['Uploading', { left: '30 s', objects: '370/1480', rate: '10.0 MB/s', size: '100.0 MB/400.0 MB' }],
      ['Uploaded the objects', { objects: 1480, size: '400.0 MB', took: '40 s' }],
      ['Uploaded the manifest', { releaseId: 7 }],
      ['Moved the channel to the bundle', { channel: 'dev', releaseId: 7, rollout: '100%', took: '47 s' }],
    ])
  })

  it('prints one line for each uploaded object, and an error line for each failure', () => {
    const { lines, logger } = recordingLogger()
    const report = createPublishReporter(logger, { now: () => 0 })
    const object = { paths: ['main/chunks/app.mjs', 'renderer/assets/app.js'], sha256: '1a2b3c4d5e6f', size: 49_357 }

    report({ durationMs: 120, newObjects: 1480, object, type: 'uploaded', uploadedObjects: 312 })
    report({ error: 'The network went away.', object, step: 'upload', type: 'failed' })

    expect(lines).toEqual([
      { fields: { object: '312/1480', paths: object.paths, sha256: '1a2b3c4d5e6f', size: '48.2 KB', took: '120 ms' }, level: 'log', message: 'Uploaded object' },
      { fields: { error: 'The network went away.', paths: object.paths, sha256: '1a2b3c4d5e6f', size: '48.2 KB', step: 'upload' }, level: 'error', message: 'Object failed' },
    ])
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
