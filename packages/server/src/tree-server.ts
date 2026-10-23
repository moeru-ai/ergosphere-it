import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import type { MemoryTree } from './tree'

import { createServer } from 'node:http'

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

export interface TreeServer {
  close: () => Promise<void>
  server: Server
  url: string
}

export interface TreeServerOptions {
  /** Returns the faults to inject now. */
  faults?: () => Faults
  host?: string
  /** Called once per tree request, for access logs and tests. */
  onRequest?: (request: RequestRecord) => void
  port?: number
  routes?: RouteHandler
  tree: MemoryTree
}

/** Serves an update tree over HTTP with the headers of each file, and injects faults. */
export async function createTreeServer(options: TreeServerOptions): Promise<TreeServer> {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (options.routes && await options.routes(request, response, path))
      return

    await serveTree(request, response, path, options)
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

async function serveTree(request: IncomingMessage, response: ServerResponse, path: string, options: TreeServerOptions): Promise<void> {
  const faults = options.faults?.() ?? NO_FAULTS
  const report = (status: number, bytes = 0, fault?: string) => options.onRequest?.({ bytes, fault, method: request.method ?? 'GET', path, status })

  if (faults.latencyMs > 0)
    await delay(faults.latencyMs)

  const file = request.method === 'GET' ? options.tree.get(path.replace(/^\/+/, '')) : undefined
  if (!file) {
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

  const size = file.bytes.byteLength
  response.writeHead(200, { ...file.headers, 'Content-Length': size })

  if (Math.random() * 100 < faults.dropRate) {
    response.destroy()
    report(200, 0, 'dropped')

    return
  }

  let bytes = file.bytes
  let fault: string | undefined
  if (faults.tamperObjects && path.startsWith('/objects/') && size > 0) {
    bytes = bytes.slice()
    bytes[0] = bytes[0]! ^ 0xFF
    fault = 'tampered'
  }

  if (faults.bytesPerSecond > 0 && path.startsWith('/objects/')) {
    const chunk = Math.max(1024, Math.floor(faults.bytesPerSecond / 10))
    for (let offset = 0; offset < size && !response.destroyed; offset += chunk) {
      response.write(bytes.subarray(offset, offset + chunk))
      await delay(100)
    }
    response.end()
    report(200, size, fault ?? `throttled to ${faults.bytesPerSecond} B/s`)

    return
  }

  response.end(bytes)
  report(200, size, fault)
}
