import type { UpdateFileSystem } from './io'

import { contentHash } from '@ergosphere-it/protocol'

/** The local content store: one file per object, named by its SHA-256. */
export class ObjectStore {
  constructor(private readonly fs: UpdateFileSystem, private readonly root: string) {}

  /** Returns true when the object is on disk and its bytes still match the hash. A damaged object is removed. */
  async hasValid(hash: string, size: number): Promise<boolean> {
    const path = this.pathOf(hash)
    if (await this.fs.fileSize(path) !== size)
      return false

    const bytes = await this.fs.readFile(path)
    if (bytes && await contentHash(bytes) === hash)
      return true

    await this.fs.remove(path)

    return false
  }

  async list(): Promise<string[]> {
    const hashes: string[] = []
    for (const prefix of await this.fs.list(this.root)) {
      for (const name of await this.fs.list(this.fs.join(this.root, prefix))) {
        if (/^[0-9a-f]{64}$/.test(name))
          hashes.push(name)
      }
    }

    return hashes
  }

  pathOf(hash: string): string {
    return this.fs.join(this.root, hash.slice(0, 2), hash)
  }

  /** Stores bytes after it checks their size and hash. Returns false when they do not match. */
  async put(hash: string, size: number, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
    if (bytes.byteLength !== size || await contentHash(bytes) !== hash)
      return false

    await this.fs.writeFileAtomic(this.pathOf(hash), bytes)

    return true
  }

  async remove(hash: string): Promise<void> {
    await this.fs.remove(this.pathOf(hash))
  }
}
