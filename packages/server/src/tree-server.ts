import type { ServerType } from '@hono/node-server'

import type { MemoryTree } from './tree'

import { serve } from '@hono/node-server'
import { delay } from 'es-toolkit'
import { Hono } from 'hono'

/** Faults that the server injects into update tree requests. Console and API requests are never affected. */
export interface Faults {
  /** Limit object downloads to this many bytes per second. 0 means no limit. */
  bytesPerSecond: number
  /** Percentage of requests whose body fails after the headers. */
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

export interface ListenOptions {
  /** Defaults to `127.0.0.1`. */
  host?: string
  /** Defaults to a free port. */
  port?: number
}

export interface RequestRecord {
  /** Bytes in the body. */
  bytes: number
  fault?: string
  method: string
  path: string
  status: number
}

export interface TreeAppOptions {
  /** Returns the faults to inject now. */
  faults?: () => Faults
  /** Called once per tree request, for access logs and tests. */
  onRequest?: (request: RequestRecord) => void
  tree: MemoryTree
}

export interface TreeServer {
  close: () => Promise<void>
  server: ServerType
  url: string
}

export interface TreeServerOptions extends ListenOptions, TreeAppOptions {}

/**
 * Returns a Hono app that serves a tree with the headers of each file, and injects faults.
 *
 * Mount it in another Hono app, or run `app.fetch` on any runtime. `createTreeServer` serves it on Node.js.
 */
export function createTreeApp(options: TreeAppOptions): Hono {
  return new Hono().get('*', c => serveTree(c.req.method, c.req.path, options))
}

/** Serves a tree over HTTP on Node.js. */
export async function createTreeServer(options: TreeServerOptions): Promise<TreeServer> {
  return listen(createTreeApp(options), options)
}

/** Serves a Hono app on Node.js. */
export async function listen(app: Hono, { host = '127.0.0.1', port = 0 }: ListenOptions = {}): Promise<TreeServer> {
  const { server, url } = await new Promise<{ server: ServerType, url: string }>((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, info => resolve({ server, url: `http://${host}:${info.port}` }))
  })

  return {
    close: () => new Promise<void>((resolve, reject) => {
      if ('closeAllConnections' in server)
        server.closeAllConnections()
      server.close(error => (error ? reject(error) : resolve()))
    }),
    server,
    url,
  }
}

async function serveTree(method: string, path: string, options: TreeAppOptions): Promise<Response> {
  const faults = options.faults?.() ?? NO_FAULTS
  const report = (status: number, bytes = 0, fault?: string) => options.onRequest?.({ bytes, fault, method, path, status })

  if (faults.latencyMs > 0)
    await delay(faults.latencyMs)

  const file = options.tree.get(path.replace(/^\/+/, ''))
  if (!file) {
    report(404)

    return new Response(null, { status: 404 })
  }
  if (Math.random() * 100 < faults.errorRate) {
    report(500, 0, 'error')

    return new Response(null, { status: 500 })
  }
  if (faults.hidePointers && path.startsWith('/pointers/')) {
    report(404, 0, 'hidden pointer')

    return new Response(null, { status: 404 })
  }

  const size = file.bytes.byteLength
  const headers = { ...file.headers, 'Content-Length': String(size) }

  if (Math.random() * 100 < faults.dropRate) {
    report(200, 0, 'dropped')

    // The headers go out, then the body fails, so the client sees a broken connection.
    return new Response(new ReadableStream({ start: controller => controller.error(new Error('dropped by a fault')) }), { headers })
  }

  let bytes = file.bytes
  let fault: string | undefined
  if (faults.tamperObjects && path.startsWith('/objects/') && size > 0) {
    bytes = bytes.slice()
    bytes[0] = bytes[0]! ^ 0xFF
    fault = 'tampered'
  }

  if (faults.bytesPerSecond > 0 && path.startsWith('/objects/')) {
    report(200, size, fault ?? `throttled to ${faults.bytesPerSecond} B/s`)

    return new Response(throttled(bytes, faults.bytesPerSecond), { headers })
  }

  report(200, size, fault)

  return new Response(bytes, { headers })
}

/** Sends bytes in chunks, ten chunks per second. */
function throttled(bytes: Uint8Array<ArrayBuffer>, bytesPerSecond: number): ReadableStream<Uint8Array<ArrayBuffer>> {
  const chunk = Math.max(1024, Math.floor(bytesPerSecond / 10))
  let offset = 0

  return new ReadableStream({
    async pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close()

        return
      }
      if (offset > 0)
        await delay(100)
      controller.enqueue(bytes.subarray(offset, offset + chunk))
      offset += chunk
    },
  })
}
