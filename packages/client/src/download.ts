import type { Fetch, UpdateFileSystem } from './io'

export interface DownloadFileOptions {
  fetch: Fetch
  fs: UpdateFileSystem
  /** Stops the download when no bytes arrive for this long. */
  idleTimeoutMs: number
  /** Called with the bytes of the file that are on disk, including bytes of an earlier attempt. */
  onBytes?: (received: number) => void
  /** The file to write. When it has bytes from an earlier attempt, the download resumes after them. */
  path: string
  /** The expected size. A server that sends more bytes fails the download. */
  size: number
  url: string
}

/**
 * A download that failed. `retryable` errors are network errors, stalls, and server errors. Another attempt can resume
 * them. Other errors need a new release or a fixed server.
 */
export class DownloadError extends Error {
  override name = 'DownloadError'

  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Downloads one file to disk, and resumes it with an HTTP `Range` request when the file has bytes already.
 *
 * It does not check the hash. The caller checks the complete file.
 */
export async function downloadFile(options: DownloadFileOptions): Promise<void> {
  const { fs, path, size, url } = options
  let offset = await fs.fileSize(path) ?? 0
  if (offset > size) {
    await fs.remove(path)
    offset = 0
  }
  if (offset === size) {
    // An empty file needs no request. Create it, so the caller finds a complete file.
    if (size === 0)
      await fs.appendFile(path, new Uint8Array())

    return
  }

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const watch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new DownloadError(`no bytes from ${url} for ${options.idleTimeoutMs} ms`, true)), options.idleTimeoutMs)
  }

  try {
    watch()
    const response = await options.fetch(url, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {}, signal: controller.signal })
    if (response.status === 416) {
      // The server has no bytes after the offset. The file on disk is not the object, so start again.
      await fs.remove(path)
      throw new DownloadError(`GET ${url} returned 416 for bytes ${offset}-`, true)
    }
    if (!response.ok)
      throw new DownloadError(`GET ${url} returned ${response.status}`, response.status >= 500 || response.status === 408 || response.status === 429)
    if (offset > 0 && response.status !== 206) {
      // The server ignored the range and sends the whole file.
      await fs.remove(path)
      offset = 0
    }
    if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) {
      await fs.remove(path)
      throw new DownloadError(`GET ${url} returned another range than bytes ${offset}-`, true)
    }

    options.onBytes?.(offset)
    const reader = response.body!.getReader()
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      watch()
      offset += chunk.value.byteLength
      if (offset > size) {
        await reader.cancel()
        await fs.remove(path)
        throw new DownloadError(`GET ${url} sent more than ${size} bytes`, false)
      }
      await fs.appendFile(path, chunk.value)
      options.onBytes?.(offset)
    }
    if (offset < size)
      throw new DownloadError(`GET ${url} ended after ${offset} of ${size} bytes`, true)
  }
  catch (error) {
    if (error instanceof DownloadError)
      throw error
    // A stall aborts the request, and fetch rejects with the abort reason.
    if (controller.signal.aborted && controller.signal.reason instanceof DownloadError)
      throw controller.signal.reason
    throw new DownloadError(`GET ${url} failed`, true, { cause: error })
  }
  finally {
    clearTimeout(timer)
  }
}
