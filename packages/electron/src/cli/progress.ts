import type { Logg } from '@guiiai/logg'

import type { PublishedObject, PublishProgress } from './commands'

export interface ReporterOptions {
  /** Milliseconds between two lines about the same step. Defaults to 5 seconds. */
  intervalMs?: number
  /** The clock in milliseconds. Tests pass their own. */
  now?: () => number
}

/**
 * Prints the steps of `publishBundle`: one line for each uploaded object and each failure, so a log names the files
 * that moved. A CI log does not redraw lines, so the rate and the time left print at most every `intervalMs`.
 */
export function createPublishReporter(log: Logg, options: ReporterOptions = {}): (progress: PublishProgress) => void {
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? 5000
  const start = now()
  let lastLine = start
  let uploadStart = start
  const due = () => now() - lastLine >= intervalMs
  const print = (logger: Logg, message: string) => {
    lastLine = now()
    logger.log(message)
  }

  return (progress) => {
    switch (progress.type) {
      case 'channel':
        print(log, `Channel ${progress.channel} now serves bundle ${progress.releaseId} to ${progress.rollout}% of installs. Published in ${formatDuration(now() - start)}.`)
        break
      case 'checked':
        uploadStart = now()
        print(log, progress.newObjects === 0
          ? `The store has all ${progress.skipped} objects. Nothing to upload.`
          : `Uploading ${progress.newObjects} new objects, ${formatBytes(progress.newBytes)}. The store has the other ${progress.skipped}.`)
        break
      case 'checking':
        if (progress.checked < progress.objects && due())
          print(log, `Checked ${progress.checked}/${progress.objects} objects.`)
        break
      case 'failed':
        lastLine = now()
        log.withFields({ sha256: progress.object.sha256 }).error(`Could not ${progress.step === 'check' ? 'check' : 'upload'} ${describeObject(progress.object)}: ${progress.error}`)
        break
      case 'manifest':
        print(log, `Uploaded the signed manifest of bundle ${progress.releaseId}.`)
        break
      case 'release':
        print(log.withFields({ channel: progress.channel, releaseId: progress.releaseId, version: progress.version }), `Publishing bundle ${progress.releaseId}: ${progress.objects} objects, ${formatBytes(progress.bytes)}. Checking which objects the store has.`)
        break
      case 'uploaded':
        log.log(`[${progress.uploadedObjects}/${progress.newObjects}] Uploaded ${describeObject(progress.object)}, in ${formatDuration(progress.durationMs)}.`)
        break
      case 'uploading': {
        const elapsed = now() - uploadStart
        if (progress.uploadedObjects === progress.newObjects) {
          print(log, `Uploaded ${progress.newObjects} objects, ${formatBytes(progress.newBytes)}, in ${formatDuration(elapsed)}.`)
          break
        }
        if (!due())
          break

        const rate = elapsed > 0 ? progress.uploadedBytes / (elapsed / 1000) : 0
        const percent = progress.newBytes > 0 ? Math.floor(progress.uploadedBytes / progress.newBytes * 100) : 0
        const left = rate > 0 ? ` About ${formatDuration((progress.newBytes - progress.uploadedBytes) / rate * 1000)} left.` : ''
        print(log, `Uploaded ${progress.uploadedObjects}/${progress.newObjects} objects, ${formatBytes(progress.uploadedBytes)} of ${formatBytes(progress.newBytes)} (${percent}%), ${formatBytes(rate)}/s.${left}`)
        break
      }
    }
  }
}

/** Bytes for people: `912 B`, `48.2 KB`, `412.6 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
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

/** The files of an object, its size, and the start of its hash: `renderer/app.js, 48.2 KB, sha256 1a2b3c4d`. */
function describeObject(object: PublishedObject): string {
  const shown = object.paths.slice(0, 3).join(', ') || 'no file'
  const more = object.paths.length > 3 ? ` and ${object.paths.length - 3} more` : ''

  return `${shown}${more}, ${formatBytes(object.size)}, sha256 ${object.sha256.slice(0, 8)}`
}
