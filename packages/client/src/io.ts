export type Fetch = (url: string, init?: FetchInit) => Promise<Response>

/** What the client passes to `fetch`: a `Range` header to resume a download, and a signal to stop a stalled one. */
export interface FetchInit {
  headers?: Record<string, string>
  signal?: AbortSignal
}

/**
 * The file system that the client needs. Hosts inject it, so the client runs on any runtime.
 *
 * Paths are platform paths built with `join`. The client never builds a path with string concatenation.
 */
export interface UpdateFileSystem {
  /** Appends bytes to a file, and creates the file and its parents when they do not exist. */
  appendFile: (path: string, data: Uint8Array) => Promise<void>
  /** Copies a file. The client uses it for objects that are already on disk. Hosts can clone instead of copy. */
  copyFile: (from: string, to: string) => Promise<void>
  /** Returns the size of a file, or `undefined` when it does not exist. */
  fileSize: (path: string) => Promise<number | undefined>
  /**
   * Returns the SHA-256 of a file as lowercase hex, or `undefined` when it does not exist.
   *
   * Hosts must stream the file. WebCrypto has no streaming digest, and objects can be large.
   */
  hashFile: (path: string) => Promise<string | undefined>
  join: (...parts: string[]) => string
  /** Lists the names in a directory. Returns an empty list when the directory does not exist. */
  list: (path: string) => Promise<string[]>
  /** Creates a directory and its parents. */
  mkdir: (path: string) => Promise<void>
  /** Returns `undefined` when the file does not exist. */
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer> | undefined>
  /** Removes a file or a directory and its contents. Does nothing when the path does not exist. */
  remove: (path: string) => Promise<void>
  /** Renames a file or a directory. The target directory must not exist. */
  rename: (from: string, to: string) => Promise<void>
  /** Writes a temporary file next to the target, then renames it over the target. */
  writeFileAtomic: (path: string, data: Uint8Array) => Promise<void>
}
