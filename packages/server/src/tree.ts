import type { TreeFile } from '@ergosphere-it/publish'

/** An update tree in memory. Tests and demos publish into it, and a tree server serves it. */
export class MemoryTree {
  private files = new Map<string, TreeFile>()

  delete(key: string): void {
    this.files.delete(key)
  }

  entries(): TreeFile[] {
    return [...this.files.values()]
  }

  get(key: string): TreeFile | undefined {
    return this.files.get(key)
  }

  /** Stores files in the order given. Pass `uploadStages(...).flat()` to keep the publish order. */
  put(files: Iterable<TreeFile>): void {
    for (const file of files)
      this.files.set(file.key, file)
  }

  /** Puts back a snapshot, for example to simulate a server that goes back to a backup. */
  restore(snapshot: readonly TreeFile[]): void {
    this.files = new Map(snapshot.map(file => [file.key, file]))
  }

  /** Copies the current files. Files are never changed in place, so the copy shares their bytes. */
  snapshot(): TreeFile[] {
    return this.entries()
  }
}
