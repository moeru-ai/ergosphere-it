import type { FileTreeStorage, ReleaseStore } from '@ergosphere-it/publish'
import type { AWSHeaders } from 's3mini'

import { createFileTreeStore } from '@ergosphere-it/publish'
import { S3mini } from 's3mini'

export interface S3StorageOptions {
  /** The access key. The storage checks it at the first read or write, so a build without credentials still works. */
  accessKeyId?: string
  /** The name of the bucket. */
  bucket: string
  /**
   * The endpoint of the S3 service, without the bucket, for example `https://<account id>.r2.cloudflarestorage.com` for
   * R2. Defaults to AWS in `region`.
   */
  endpoint?: string
  /** A key prefix in the bucket, for example `my-app`. */
  prefix?: string
  /** The region. Defaults to `us-east-1` on AWS, and to `auto` on another endpoint, as R2 needs. */
  region?: string
  /** The secret key. The storage checks it at the first read or write, so a build without credentials still works. */
  secretAccessKey?: string
}

/**
 * Creates a storage of files on an S3 bucket, for `createFileTreeStore`. Most apps use `createS3Store`, which keeps the
 * default layout in it.
 */
export function createS3Storage(options: S3StorageOptions): FileTreeStorage {
  const prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '')
  const name = `s3://${options.bucket}${prefix ? `/${prefix}` : ''}`
  const keyOf = (key: string) => (prefix ? `${prefix}/${key}` : key)
  let client: S3mini | undefined
  const connect = (): S3mini => {
    if (client)
      return client

    const { accessKeyId, secretAccessKey } = options
    if (!accessKeyId || !secretAccessKey)
      throw new Error(`ergosphere-it: ${name} has no accessKeyId or secretAccessKey. With --bucket s3://, set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.`)

    const region = options.region ?? (options.endpoint ? 'auto' : 'us-east-1')
    const endpoint = options.endpoint?.replace(/\/+$/, '') ?? `https://s3.${region}.amazonaws.com`
    client = new S3mini({ accessKeyId, endpoint: `${endpoint}/${options.bucket}`, region, secretAccessKey })

    return client
  }

  return {
    async list(listPrefix) {
      const objects = await connect().listObjects('/', keyOf(listPrefix))

      return (objects ?? []).map(object => (prefix ? object.Key.slice(prefix.length + 1) : object.Key))
    },
    name,
    async read(key) {
      const buffer = await connect().getObjectArrayBuffer(keyOf(key))

      return buffer ? new Uint8Array(buffer) : undefined
    },
    async write(file) {
      // NOTICE:
      // s3mini types extra headers as `x-amz-*`, but it signs and sends every header it gets.
      // Cache-Control must reach the bucket, so a CDN caches objects forever and channel files never.
      // Source: node_modules/s3mini/dist/index.mjs, putObject spreads `additionalHeaders` into the signed request.
      // Removal condition: s3mini types standard headers such as Cache-Control.
      const headers = { 'Cache-Control': file.headers['Cache-Control'] } as unknown as AWSHeaders
      await connect().putObject(keyOf(file.key), file.bytes, file.headers['Content-Type'], undefined, headers)
    },
  }
}

/**
 * Creates a release store that keeps the default layout in an S3 bucket, or on a service with the same API, for example
 * R2 or MinIO. Put it into `store` of `ergo.config.ts`:
 *
 * ```ts
 * import { env } from 'node:process'
 *
 * import { defineConfig } from '@ergosphere-it/electron/config'
 * import { createS3Store } from '@ergosphere-it/electron/storage/s3'
 *
 * export default defineConfig({
 *   // ...
 *   store: createS3Store({
 *     accessKeyId: env.R2_ACCESS_KEY_ID,
 *     bucket: 'my-app-updates',
 *     endpoint: env.R2_ENDPOINT,
 *     secretAccessKey: env.R2_SECRET_ACCESS_KEY,
 *   }),
 * })
 * ```
 *
 * The build reads `ergo.config.ts` too, without the credentials of CI, so the store connects at its first read or write.
 */
export function createS3Store(options: S3StorageOptions): ReleaseStore {
  return createFileTreeStore(createS3Storage(options))
}
