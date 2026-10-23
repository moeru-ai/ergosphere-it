import type { ServerType } from '@hono/node-server'

import type { MemoryTree } from './tree'

import { serve } from '@hono/node-server'
import { delay } from 'es-toolkit'
import { Hono } from 'hono'

/** Faults that the server injects into update tree requests. Console and API requests are never affected. */
export interface Faults {
  /** Limit object downloads to this many bytes per second. 0 means no limit. */
  bytesPerSecond: number
  /** Percentage of requests whose body fails after half of its bytes, as a dropped connection does. */
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
  /** The `Range` header of a resumed download. */
  range?: string
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
  return new Hono().get('*', c => serveTree(c.req.method, c.req.path, c.req.header('range'), options))
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

/** Sends some bytes, then fails, as a dropped connection does. */
function dropped(sent: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  let pulls = 0

  return new ReadableStream({
    async pull(controller) {
      if (pulls++ === 0 && sent.byteLength > 0) {
        controller.enqueue(sent)

        return
      }
      // NOTICE:
      // The error waits, so the sent bytes reach the client first.
      // controller.error() drops chunks that the reader has not read yet, and @hono/node-server destroys the socket on
      // a stream error, which drops bytes that are not flushed yet.
      // Source: WHATWG Streams ReadableStreamDefaultControllerError, and the node-server response writer.
      // Removal condition: none while the fault must deliver part of a body.
      await delay(100)
      controller.error(new Error('dropped by a fault'))
    },
  })
}

async function serveTree(method: string, path: string, range: string | undefined, options: TreeAppOptions): Promise<Response> {
  const faults = options.faults?.() ?? NO_FAULTS
  const report = (status: number, bytes = 0, fault?: string) => options.onRequest?.({ bytes, fault, method, path, range, status })

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

  let bytes = file.bytes
  let fault: string | undefined
  if (faults.tamperObjects && path.startsWith('/objects/') && bytes.byteLength > 0) {
    bytes = bytes.slice()
    bytes[0] = bytes[0]! ^ 0xFF
    fault = 'tampered'
  }

  // Serve `bytes=<start>-` and `bytes=<start>-<end>`, so clients can resume a download.
  let status = 200
  const headers: Record<string, string> = { ...file.headers, 'Accept-Ranges': 'bytes' }
  const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null
  if (match) {
    const total = bytes.byteLength
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
    if (start >= total || start > end) {
      report(416)

      return new Response(null, { headers: { 'Content-Range': `bytes */${total}` }, status: 416 })
    }
    bytes = bytes.subarray(start, end + 1)
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    status = 206
  }
  const size = bytes.byteLength
  headers['Content-Length'] = String(size)

  if (Math.random() * 100 < faults.dropRate) {
    report(status, Math.floor(size / 2), 'dropped')

    return new Response(dropped(bytes.subarray(0, Math.floor(size / 2))), { headers, status })
  }

  if (faults.bytesPerSecond > 0 && path.startsWith('/objects/')) {
    report(status, size, fault ?? `throttled to ${faults.bytesPerSecond} B/s`)

    return new Response(throttled(bytes, faults.bytesPerSecond), { headers, status })
  }

  report(status, size, fault)

  return new Response(bytes, { headers, status })
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
