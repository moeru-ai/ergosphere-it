import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, normalize, sep } from 'node:path'

import { delay } from 'es-toolkit'

/** Faults that the server injects into update tree requests. Console and API requests are never affected. */
export interface Faults {
  /** Limit object downloads to this many bytes per second. 0 means no limit. */
  bytesPerSecond: number
  /** Percentage of requests whose connection closes before the body. */
  dropRate: number
  /** Percentage of requests that get HTTP 500. */
  errorRate: number
  /** Answer pointer requests with 404. */
  hidePointers: boolean
  /** Delay before each response. */
  latencyMs: number
  /** Change one byte of every object, so clients see a hash mismatch. */
  tamperObjects: boolean
}

export const NO_FAULTS: Faults = { bytesPerSecond: 0, dropRate: 0, errorRate: 0, hidePointers: false, latencyMs: 0, tamperObjects: false }

export interface RequestRecord {
  /** Bytes sent in the body. */
  bytes: number
  fault?: string
  method: string
  path: string
  status: number
}

/** Extra routes. Return true when the route answered the request. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse, path: string) => Promise<boolean>

export interface StaticServer {
  close: () => Promise<void>
  server: Server
  url: string
}

export interface StaticServerOptions {
  /** Returns the faults to inject now. */
  faults?: () => Faults
  host?: string
  /** Called once per tree request, for access logs and tests. */
  onRequest?: (request: RequestRecord) => void
  port?: number
  /** The update tree that the publish CLI writes. */
  root: string
}

/** Creates an HTTP server for an update tree, with optional extra routes. */
export async function createStaticServer(options: StaticServerOptions & { routes?: RouteHandler }): Promise<StaticServer> {
  const root = normalize(options.root)

  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (options.routes && await options.routes(request, response, path))
      return

    await serveTree(root, request, response, path, options)
  })

  const host = options.host ?? '127.0.0.1'
  await new Promise<void>(resolve => server.listen(options.port ?? 0, host, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port

  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error ? reject(error) : resolve()))
    }),
    server,
    url: `http://${host}:${port}`,
  }
}

/**
 * Serves one request of the update tree.
 *
 * Objects and manifests never change, so they can be cached forever. Pointers change, so they are never cached.
 */
async function serveTree(root: string, request: IncomingMessage, response: ServerResponse, path: string, options: StaticServerOptions): Promise<void> {
  const faults = options.faults?.() ?? NO_FAULTS
  const report = (status: number, bytes = 0, fault?: string) => options.onRequest?.({ bytes, fault, method: request.method ?? 'GET', path, status })
  const file = normalize(join(root, path))

  if (faults.latencyMs > 0)
    await delay(faults.latencyMs)

  if (request.method !== 'GET' || !file.startsWith(root + sep)) {
    response.writeHead(404).end()
    report(404)

    return
  }
  if (Math.random() * 100 < faults.errorRate) {
    response.writeHead(500).end()
    report(500, 0, 'error')

    return
  }
  if (faults.hidePointers && path.startsWith('/pointers/')) {
    response.writeHead(404).end()
    report(404, 0, 'hidden pointer')

    return
  }

  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile())
      throw new Error('not a file')
    size = info.size
  }
  catch {
    response.writeHead(404).end()
    report(404)

    return
  }

  response.writeHead(200, {
    'Cache-Control': path.startsWith('/pointers/') ? 'no-store' : 'public, max-age=31536000, immutable',
    'Content-Length': size,
    'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
  })

  if (Math.random() * 100 < faults.dropRate) {
    response.destroy()
    report(200, 0, 'dropped')

    return
  }
  if (faults.tamperObjects && path.startsWith('/objects/') && size > 0) {
    const bytes = await readFile(file)
    bytes[0] = bytes[0]! ^ 0xFF
    response.end(bytes)
    report(200, size, 'tampered')

    return
  }

  if (faults.bytesPerSecond > 0 && path.startsWith('/objects/')) {
    const bytes = await readFile(file)
    const chunk = Math.max(1024, Math.floor(faults.bytesPerSecond / 10))
    for (let offset = 0; offset < bytes.length && !response.destroyed; offset += chunk) {
      response.write(bytes.subarray(offset, offset + chunk))
      await delay(100)
    }
    response.end()
    report(200, size, `throttled to ${faults.bytesPerSecond} B/s`)

    return
  }

  createReadStream(file).pipe(response)
  report(200, size)
}

export { createDevServer } from './dev-server'
export type { ClientReport, DevServer, DevServerOptions, ReleaseChange, ReleaseEntry } from './dev-server'
