import type { UpdateFileSystem } from './io'

/** The local content store: one file per object, named by its SHA-256. */
export class ObjectStore {
  private readonly fs: UpdateFileSystem
  private readonly root: string

  constructor(fs: UpdateFileSystem, root: string) {
    this.fs = fs
    this.root = root
  }

  /**
   * Takes a complete file as an object after it checks its size and hash, and moves it into the store.
   *
   * Returns false and removes the file when it does not match.
   */
  async adopt(hash: string, size: number, path: string): Promise<boolean> {
    if (await this.fs.fileSize(path) !== size || await this.fs.hashFile(path) !== hash) {
      await this.fs.remove(path)

      return false
    }

    await this.fs.rename(path, this.pathOf(hash))

    return true
  }

  /** Copies a file from another directory into the store, for example from the bundle of the installer. */
  async copyIn(hash: string, size: number, from: string): Promise<boolean> {
    if (await this.fs.fileSize(from) !== size)
      return false

    const temporary = `${this.partPath(hash)}.copy`
    await this.fs.copyFile(from, temporary)

    return this.adopt(hash, size, temporary)
  }

  /** Returns true when the object is on disk and its bytes still match the hash. A damaged object is removed. */
  async hasValid(hash: string, size: number): Promise<boolean> {
    const path = this.pathOf(hash)
    if (await this.fs.fileSize(path) !== size)
      return false
    if (await this.fs.hashFile(path) === hash)
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

  /** Lists the partial files of downloads and copies, which a failure or a crash can leave behind. */
  async listPartial(): Promise<string[]> {
    const paths: string[] = []
    for (const prefix of await this.fs.list(this.root)) {
      for (const name of await this.fs.list(this.fs.join(this.root, prefix))) {
        if (/^[0-9a-f]{64}\.part(?:\.copy)?$/.test(name))
          paths.push(this.fs.join(this.root, prefix, name))
      }
    }

    return paths
  }

  /** The file that a download writes to. It stays between attempts, so the next attempt can resume it. */
  partPath(hash: string): string {
    return `${this.pathOf(hash)}.part`
  }

  pathOf(hash: string): string {
    return this.fs.join(this.root, hash.slice(0, 2), hash)
  }

  async remove(hash: string): Promise<void> {
    await this.fs.remove(this.pathOf(hash))
    await this.fs.remove(this.partPath(hash))
  }
}
