import type { AddressInfo } from 'node:net'

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createS3Storage } from './s3'

/** A request that the fake S3 service got: the method, the path, and the headers that matter here. */
interface Received { cacheControl?: string, contentType?: string, method: string, path: string }

const objects = new Map<string, Uint8Array>()
const received: Received[] = []
let endpoint: string
const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://localhost')
  received.push({ cacheControl: request.headers['cache-control'], contentType: request.headers['content-type'], method: request.method!, path: url.pathname })
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const key = url.pathname.replace(/^\/updates\//, '')
    if (request.method === 'PUT') {
      objects.set(key, new Uint8Array(Buffer.concat(chunks)))
      response.writeHead(200, { ETag: '"etag"' }).end()
    }
    else if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const contents = [...objects.keys()].filter(name => name.startsWith(prefix)).map(name => `<Contents><Key>${name}</Key><Size>1</Size></Contents>`)
      response.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join('')}</ListBucketResult>`)
    }
    else if (objects.has(key)) {
      response.writeHead(200).end(objects.get(key))
    }
    else {
      response.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>')
    }
  })
})

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

describe('createS3Storage', () => {
  it('connects at the first read, so a build without credentials can load the config', async () => {
    const storage = createS3Storage({ bucket: 'updates', endpoint, prefix: '/my-app/' })

    expect(storage.name).toBe('s3://updates/my-app')
    await expect(storage.read('channels/stable.json')).rejects.toThrow('has no accessKeyId or secretAccessKey')
    expect(received).toEqual([])
  })

  it('writes under the prefix with the Cache-Control of the file, and reads and lists the files back', async () => {
    const storage = createS3Storage({ accessKeyId: 'id', bucket: 'updates', endpoint, prefix: 'my-app', secretAccessKey: 'secret' })
    const bytes = new TextEncoder().encode('{}')

    await storage.write({ bytes, headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' }, immutable: false, key: 'channels/stable.json' })

    expect(received.at(-1)).toEqual({ cacheControl: 'no-cache', contentType: 'application/json', method: 'PUT', path: '/updates/my-app/channels/stable.json' })
    expect(await storage.read('channels/stable.json')).toEqual(bytes)
    expect(await storage.read('channels/beta.json')).toBeUndefined()
    expect(await storage.list!('channels/')).toEqual(['channels/stable.json'])
  })
})
