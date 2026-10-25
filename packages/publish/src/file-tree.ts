import type { TreeFile } from './index'
import type { ReleaseStore } from './store'

import { bundleTreeFiles, channelKey, channelTreeFiles, feedTreeFile, installerTreeFiles, objectKey, objectTreeFile } from './tree'

/**
 * A storage of files: a callback that reads a file and one that writes it. `createFileTreeStore` keeps the default
 * layout in it. `createS3Storage` of `@ergosphere-it/electron/storage/s3` gives one on S3.
 *
 * - `write` keeps the `Content-Type` and the `Cache-Control` of the file. A CDN caches objects forever and channel files
 *   never, so a lost `Cache-Control` serves old channel files.
 * - A file is readable when `write` returns.
 */
export interface FileTreeStorage {
  /** Lists the keys under a prefix. Without it, `withdraw` needs `--channel`. */
  list?: (prefix: string) => Promise<string[]>
  /** Names the storage in messages, for example `s3://my-app-updates`. */
  name?: string
  /** Returns a file, or `undefined` when the key does not exist. */
  read: (key: string) => Promise<Uint8Array | undefined>
  write: (file: TreeFile) => Promise<void>
}

/**
 * Creates a release store on the default layout of the specification, in a storage of files. An app reads the layout
 * from `feedUrl` with no code of its own.
 */
export function createFileTreeStore(storage: FileTreeStorage): ReleaseStore {
  if (typeof storage.read !== 'function' || typeof storage.write !== 'function')
    throw new TypeError('ergosphere-it: a file tree storage needs read and write callbacks.')

  const writeAll = async (files: TreeFile[]) => {
    for (const file of files)
      await storage.write(file)
  }

  return {
    async getChannel(channel) {
      const bytes = await storage.read(channelKey(channel))
      const signature = bytes && await storage.read(`${channelKey(channel)}.sig`)

      return bytes && signature ? { bytes, signature: new TextDecoder().decode(signature) } : undefined
    },
    async hasObject(sha256) {
      return await storage.read(objectKey(sha256)) !== undefined
    },
    listChannels: storage.list && (async () => (await storage.list!('channels/'))
      .filter(key => key.endsWith('.json'))
      .map(key => key.slice('channels/'.length, -'.json'.length))),
    name: storage.name ?? 'the file tree',
    putBundle: async bundle => writeAll(bundleTreeFiles(bundle.document.releaseId, bundle)),
    putChannel: async next => writeAll(channelTreeFiles(next.document.channel, next)),
    putInstaller: async installer => writeAll([...installer.feeds.map(feed => feedTreeFile(installer.document.releaseId, feed)), ...installerTreeFiles(installer.document.releaseId, installer)]),
    putObject: async object => storage.write(objectTreeFile(object)),
  }
}
