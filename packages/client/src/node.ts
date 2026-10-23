import type { UpdateFileSystem } from './io'

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pid } from 'node:process'
import { pipeline } from 'node:stream/promises'

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
      await rename(from, to)
    },
    async writeFileAtomic(path, data) {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${pid}.${tempCounter++}.tmp`
      await writeFile(temporary, data)
      await rename(temporary, path)
    },
  }
}
