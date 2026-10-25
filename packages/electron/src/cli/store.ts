import type { FileTreeStorage, ReleaseStore } from '@ergosphere-it/publish'

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'

import { createFileTreeStore } from '@ergosphere-it/publish'

import { findErgoConfig, loadErgoConfig } from '../config'
import { createS3Store } from '../storage/s3'

/** Where the release store of a command came from, for the output of the CLI. */
export type StoreSource = '--store' | 'ergo.config.ts' | 'ERGOSPHERE_IT_STORE'

/**
 * Opens a release store on the file tree in a bucket or a directory, from its URL.
 *
 * - `s3://<bucket>/<prefix>` uses S3 or a service with the same API, for example R2. Credentials come from
 *   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The endpoint comes from `ERGOSPHERE_IT_S3_ENDPOINT` or
 *   `AWS_ENDPOINT_URL_S3`, or from `AWS_REGION` for AWS. For R2, set `ERGOSPHERE_IT_S3_ENDPOINT` to `https://<account id>.r2.cloudflarestorage.com`.
 * - A `file://` URL or a path writes to a directory, for example for another upload tool.
 */
export function openStore(url: string): ReleaseStore {
  if (url.startsWith('s3://')) {
    const { hostname: bucket, pathname: prefix } = new URL(url)

    return createS3Store({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      bucket,
      endpoint: env.ERGOSPHERE_IT_S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3,
      prefix,
      region: env.AWS_REGION,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    })
  }

  return createFileTreeStore(directoryStorage(url.startsWith('file://') ? fileURLToPath(url) : resolve(url)))
}

/**
 * Finds the release store of a command: the URL of `--store`, then the URL of `ERGOSPHERE_IT_STORE`, then `store` of
 * `ergo.config.ts` in `root`.
 */
export async function resolveStore(flag: string | undefined, variable: string | undefined, root: string): Promise<{ source: StoreSource, store: ReleaseStore }> {
  if (flag)
    return { source: '--store', store: openStore(flag) }
  if (variable)
    return { source: 'ERGOSPHERE_IT_STORE', store: openStore(variable) }

  const store = findErgoConfig(root) === undefined ? undefined : (await loadErgoConfig(root)).store
  if (!store)
    throw new Error('ergosphere-it: no release store. Set store in ergo.config.ts, or pass --store or ERGOSPHERE_IT_STORE. Run ergosphere-it --help.')

  return { source: 'ergo.config.ts', store }
}

function directoryStorage(root: string): FileTreeStorage {
  const pathOf = (key: string) => join(root, ...key.split('/'))

  return {
    async list(prefix) {
      const dir = pathOf(prefix.replace(/\/$/, ''))
      if (!existsSync(dir))
        return []

      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => [prefix.replace(/\/$/, ''), ...join(entry.parentPath, entry.name).slice(dir.length + 1).split(/[/\\]/)].join('/'))
    },
    name: root,
    async read(key) {
      const path = pathOf(key)

      return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined
    },
    async write(file) {
      const path = pathOf(file.key)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.bytes)
    },
  }
}
