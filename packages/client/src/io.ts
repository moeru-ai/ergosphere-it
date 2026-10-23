/**
 * The file system that the client needs. Hosts inject it, so the client runs on any runtime.
 *
 * Paths are platform paths built with `join`. The client never builds a path with string concatenation.
 */
export interface UpdateFileSystem {
  join: (...parts: string[]) => string
  /** Returns `undefined` when the file does not exist. */
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer> | undefined>
  /** Writes a temporary file next to the target, then renames it over the target. */
  writeFileAtomic: (path: string, data: Uint8Array) => Promise<void>
  /** Returns the size of a file, or `undefined` when it does not exist. */
  fileSize: (path: string) => Promise<number | undefined>
  /** Renames a file or a directory. The target directory must not exist. */
  rename: (from: string, to: string) => Promise<void>
  /** Creates a directory and its parents. */
  mkdir: (path: string) => Promise<void>
  /** Removes a file or a directory and its contents. Does nothing when the path does not exist. */
  remove: (path: string) => Promise<void>
  /** Lists the names in a directory. Returns an empty list when the directory does not exist. */
  list: (path: string) => Promise<string[]>
  /** Copies a file. The client uses it for objects that are already on disk. Hosts can clone instead of copy. */
  copyFile: (from: string, to: string) => Promise<void>
}

export type Fetch = (url: string) => Promise<Response>
