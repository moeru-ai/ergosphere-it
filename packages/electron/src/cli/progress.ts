import type { Logg } from '@guiiai/logg'

import type { PublishedObject, PublishProgress } from './commands'

export interface ReporterOptions {
  /** Milliseconds between two progress lines of the same step. Defaults to 5 seconds. */
  intervalMs?: number
  /** The clock in milliseconds. Tests pass their own. */
  now?: () => number
}

/**
 * Prints the steps of `publishBundle` with logg: a short message, and the data as fields. Each uploaded object and each
 * failure gets a line, so a log names the files that moved. A CI log does not redraw lines, so the rate and the time
 * left print at most every `intervalMs`.
 */
export function createPublishReporter(log: Logg, options: ReporterOptions = {}): (progress: PublishProgress) => void {
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? 5000
  const start = now()
  let lastLine = start
  let uploadStart = start
  const due = () => now() - lastLine >= intervalMs
  const objectFields = (object: PublishedObject) => ({ paths: object.paths, sha256: object.sha256, size: formatBytes(object.size) })

  return (progress) => {
    switch (progress.type) {
      case 'channel':
        log.withFields({ channel: progress.channel, releaseId: progress.releaseId, rollout: `${progress.rollout}%`, took: formatDuration(now() - start) }).log('Moved the channel to the bundle')
        break
      case 'checked':
        uploadStart = now()
        lastLine = uploadStart
        log.withFields({ inStore: progress.skipped, newObjects: progress.newObjects, newSize: formatBytes(progress.newBytes) }).log('Checked the store')
        break
      case 'checking':
        if (progress.checked < progress.objects && due()) {
          lastLine = now()
          log.withFields({ checked: `${progress.checked}/${progress.objects}` }).log('Checking objects')
        }
        break
      case 'failed':
        log.withFields({ ...objectFields(progress.object), error: progress.error, step: progress.step }).error('Object failed')
        break
      case 'manifest':
        log.withFields({ releaseId: progress.releaseId }).log('Uploaded the manifest')
        break
      case 'release':
        log.withFields({ channel: progress.channel, objects: progress.objects, releaseId: progress.releaseId, size: formatBytes(progress.bytes), version: progress.version }).log('Publishing the bundle')
        break
      case 'uploaded':
        log.withFields({ ...objectFields(progress.object), object: `${progress.uploadedObjects}/${progress.newObjects}`, took: formatDuration(progress.durationMs) }).log('Uploaded object')
        break
      case 'uploading': {
        const elapsedMs = now() - uploadStart
        if (progress.uploadedObjects === progress.newObjects) {
          log.withFields({ objects: progress.newObjects, size: formatBytes(progress.newBytes), took: formatDuration(elapsedMs) }).log('Uploaded the objects')
          break
        }
        if (!due())
          break

        lastLine = now()
        const bytesPerSecond = elapsedMs > 0 ? progress.uploadedBytes / (elapsedMs / 1000) : 0
        log.withFields({
          left: bytesPerSecond > 0 ? formatDuration((progress.newBytes - progress.uploadedBytes) / bytesPerSecond * 1000) : undefined,
          objects: `${progress.uploadedObjects}/${progress.newObjects}`,
          rate: `${formatBytes(bytesPerSecond)}/s`,
          size: `${formatBytes(progress.uploadedBytes)}/${formatBytes(progress.newBytes)}`,
        }).log('Uploading')
        break
      }
    }
  }
}

/** Bytes for people: `912 B`, `48.2 KB`, `412.6 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`

  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** A duration for people: `850 ms`, `42 s`, `2 min 13 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000)
    return `${Math.round(ms)} ms`

  const seconds = Math.round(ms / 1000)
  if (seconds < 60)
    return `${seconds} s`

  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}
