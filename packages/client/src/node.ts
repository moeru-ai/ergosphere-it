import type { UpdateFileSystem } from './io'

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pid } from 'node:process'
import { pipeline } from 'node:stream/promises'

import { delay } from 'es-toolkit'

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

let tempCounter = 0

/** A file system for Node.js hosts, for example the Electron main process. */
export function createNodeFileSystem(): UpdateFileSystem {
  return {
    async appendFile(path, data) {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, data)
    },
    async copyFile(from, to) {
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
    },
    async fileSize(path) {
      try {
        const info = await stat(path)

        return info.isFile() ? info.size : undefined
      }
      catch (error) {
        if (isMissing(error))
          return undefined

        throw error
      }
    },
    async hashFile(path) {
      const hash = createHash('sha256')
      try {
        await pipeline(createReadStream(path), hash)
      }
      catch (error) {
        if (isMissing(error))
          return undefined

        throw error
      }

      return hash.digest('hex')
    },
    join,
    async list(path) {
      try {
        return await readdir(path)
      }
      catch (error) {
        if (isMissing(error))
          return []

        throw error
      }
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true })
    },
    async readFile(path) {
      try {
        const buffer = await readFile(path)

        return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
      }
      catch (error) {
        if (isMissing(error))
          return undefined

        throw error
      }
    },
    async remove(path) {
      await rm(path, { force: true, maxRetries: 3, recursive: true })
    },
    async rename(from, to) {
      await mkdir(dirname(to), { recursive: true })
      await renameWithRetry(from, to)
    },
    async writeFileAtomic(path, data) {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${pid}.${tempCounter++}.tmp`
      // Flush the bytes before the rename, so a power loss never leaves an empty file under the final name.
      const file = await open(temporary, 'w')
      try {
        await file.writeFile(data)
        await file.sync()
      }
      finally {
        await file.close()
      }
      await renameWithRetry(temporary, path)
    },
  }
}

/**
 * Renames a file, and retries for a short time when another process holds it.
 *
 * On Windows, antivirus software and the search indexer open new files for a moment, and a rename then fails with
 * EPERM, EACCES, or EBUSY. graceful-fs retries for the same reason.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)

      return
    }
    catch (error) {
      const code = (error as { code?: string }).code
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY'))
        throw error
      await delay(50 * (attempt + 1))
    }
  }
}
