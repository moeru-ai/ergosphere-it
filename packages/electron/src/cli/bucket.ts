import type { TreeFile } from '@ergosphere-it/publish'
import type { AWSHeaders } from 's3mini'

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'

import { S3mini } from 's3mini'

/** Where the CLI reads and writes the update tree. The app reads the same files from `feedUrl`. */
export interface Bucket {
  /** Returns a file, or `undefined` when the key does not exist. */
  get: (key: string) => Promise<Uint8Array<ArrayBuffer> | undefined>
  /** Lists the keys under a prefix. */
  list: (prefix: string) => Promise<string[]>
  put: (file: TreeFile) => Promise<void>
  /** Names the bucket in logs. */
  readonly url: string
}

/**
 * Opens a bucket from its URL.
 *
 * - `s3://<bucket>/<prefix>` uses S3 or a service with the same API, for example R2. Credentials come from
 *   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The endpoint comes from `UPDATES_S3_ENDPOINT`, or from `AWS_REGION`
 *   for AWS. For R2, set `UPDATES_S3_ENDPOINT` to `https://<account id>.r2.cloudflarestorage.com`.
 * - A `file://` URL or a path writes to a directory, for example for another upload tool.
 */
export function openBucket(url: string): Bucket {
  if (url.startsWith('s3://'))
    return s3Bucket(url)

  return directoryBucket(url.startsWith('file://') ? fileURLToPath(url) : resolve(url))
}

function directoryBucket(root: string): Bucket {
  const pathOf = (key: string) => join(root, ...key.split('/'))

  return {
    async get(key) {
      const path = pathOf(key)

      return existsSync(path) ? new Uint8Array(readFileSync(path)) as Uint8Array<ArrayBuffer> : undefined
    },
    async list(prefix) {
      const dir = pathOf(prefix.replace(/\/$/, ''))
      if (!existsSync(dir))
        return []

      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => [prefix.replace(/\/$/, ''), ...join(entry.parentPath, entry.name).slice(dir.length + 1).split(/[/\\]/)].join('/'))
    },
    async put(file) {
      const path = pathOf(file.key)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.bytes)
    },
    url: root,
  }
}

function s3Bucket(url: string): Bucket {
  const { hostname: bucket, pathname } = new URL(url)
  const prefix = pathname.replace(/^\/+|\/+$/g, '')
  const keyOf = (key: string) => (prefix ? `${prefix}/${key}` : key)
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey)
    throw new Error('ergosphere-it: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to write to an S3 bucket.')

  const endpoint = env.UPDATES_S3_ENDPOINT?.replace(/\/+$/, '') ?? `https://s3.${env.AWS_REGION ?? 'us-east-1'}.amazonaws.com`
  const client = new S3mini({ accessKeyId, endpoint: `${endpoint}/${bucket}`, region: env.AWS_REGION ?? 'auto', secretAccessKey })

  return {
    async get(key) {
      const buffer = await client.getObjectArrayBuffer(keyOf(key))

      return buffer ? new Uint8Array(buffer) : undefined
    },
    async list(listPrefix) {
      const objects = await client.listObjects('/', keyOf(listPrefix))

      return (objects ?? []).map(object => (prefix ? object.Key.slice(prefix.length + 1) : object.Key))
    },
    async put(file) {
      // NOTICE:
      // s3mini types extra headers as `x-amz-*`, but it signs and sends every header it gets.
      // Cache-Control must reach the bucket, so a CDN caches objects forever and channel files never.
      // Source: node_modules/s3mini/dist/index.mjs, putObject spreads `additionalHeaders` into the signed request.
      // Removal condition: s3mini types standard headers such as Cache-Control.
      const headers = { 'Cache-Control': file.headers['Cache-Control'] } as unknown as AWSHeaders
      await client.putObject(keyOf(file.key), file.bytes, file.headers['Content-Type'], undefined, headers)
    },
    url,
  }
}
