import type { Logg } from '@guiiai/logg'

import type { PublishedObject, PublishProgress } from './commands'

export interface ReporterOptions {
  /** Milliseconds between two progress lines of the same step. Defaults to 5 seconds. */
  intervalMs?: number
  /** The clock in milliseconds. Tests pass their own. */
  now?: () => number
}

/**
 * Prints the steps of `publishBundle` as short sentences that start with the file, as the download plugins of AIRI print
 * their downloads: `renderer/app.js uploaded (48.2 KB, 120 ms).` Each uploaded object and each failure gets a line, so
 * a log names the files that moved. A CI log does not redraw lines, so the progress of a long step prints at most
 * every `intervalMs`.
 */
export function createPublishReporter(log: Logg, options: ReporterOptions = {}): (progress: PublishProgress) => void {
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? 5000
  const start = now()
  let lastLine = start
  let uploadStart = start
  const due = () => now() - lastLine >= intervalMs
  const files = (object: PublishedObject) => object.paths.join(', ') || `object ${object.sha256}`

  return (progress) => {
    switch (progress.type) {
      case 'channel':
        log.log(`Channel ${progress.channel} now serves bundle ${progress.releaseId} to ${progress.rollout}% of installs (${formatDuration(now() - start)}).`)
        break
      case 'checked':
        uploadStart = now()
        lastLine = uploadStart
        log.log(progress.newObjects === 0
          ? `All ${progress.skipped} objects already exist in the store.`
          : `${progress.newObjects} objects to upload (${formatBytes(progress.newBytes)}), ${progress.skipped} already exist in the store.`)
        break
      case 'checking':
        if (progress.checked < progress.objects && due()) {
          lastLine = now()
          log.log(`Checked ${progress.checked} of ${progress.objects} objects...`)
        }
        break
      case 'failed':
        log.error(`Could not ${progress.step} ${files(progress.object)} (sha256 ${progress.object.sha256}): ${progress.error}`)
        break
      case 'manifest':
        log.log(`Manifest of bundle ${progress.releaseId} uploaded.`)
        break
      case 'release':
        log.log(`Publishing bundle ${progress.releaseId} (${progress.version}) to ${progress.channel}: ${progress.objects} objects, ${formatBytes(progress.bytes)}...`)
        break
      case 'uploaded':
        log.log(`${files(progress.object)} uploaded (${formatBytes(progress.object.size)}, ${formatDuration(progress.durationMs)}).`)
        break
      case 'uploading': {
        const elapsedMs = now() - uploadStart
        if (progress.uploadedObjects === progress.newObjects) {
          log.log(`All ${progress.newObjects} objects uploaded (${formatBytes(progress.newBytes)}, ${formatDuration(elapsedMs)}).`)
          break
        }
        if (!due())
          break

        lastLine = now()
        const bytesPerSecond = elapsedMs > 0 ? progress.uploadedBytes / (elapsedMs / 1000) : 0
        const left = bytesPerSecond > 0 ? `, about ${formatDuration((progress.newBytes - progress.uploadedBytes) / bytesPerSecond * 1000)} left` : ''
        log.log(`Uploaded ${progress.uploadedObjects} of ${progress.newObjects} objects (${formatBytes(progress.uploadedBytes)} of ${formatBytes(progress.newBytes)}, ${formatBytes(bytesPerSecond)}/s${left})...`)
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
