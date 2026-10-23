import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Pointer, SigningKey } from '@ergosphere-it/protocol'
import type { CoreRelease } from '@ergosphere-it/publish'

import type { MemoryTree } from './tree'
import type { Faults, TreeServer } from './tree-server'

import { Buffer } from 'node:buffer'

import { buildPointer, createSeq, uploadStages } from '@ergosphere-it/publish'
import { errorMessageFrom } from '@moeru/std/error'

import { consolePage } from './console-page'
import { createTreeServer, NO_FAULTS } from './tree-server'

/** What the host reports about the app. The console uses it to show desyncs between the app and the server. */
export interface ClientReport {
  /** Cores that the app blocked after failures. */
  blocked?: number[]
  /** The result of the last update check of the app, for example `{ status: 'server-behind', current, seq }`. */
  lastCheck?: { [key: string]: unknown, status: string }
  pid?: number
  /** The seq of the core that the app runs. */
  running?: number
  /** The version of the core that the app runs, from its manifest. */
  runningVersion?: string
}

export interface DevServer extends TreeServer {
  /** The URL of the console page. */
  consoleUrl: string
  /** Shows the state of a client in the console, for example the core it runs and the cores it blocked. */
  setClientState: (state: ClientReport) => void
}

export interface DevServerOptions {
  /** Channels that the console offers. The first one is the default. */
  channels?: string[]
  /** Faults to inject from the start, for example a bandwidth limit that makes download progress visible. */
  faults?: Partial<Faults>
  host?: string
  port?: number
  product: string
  /** How the console publishes. Without it, the console can still revoke what the tree holds. */
  release?: {
    /** Builds a release. The server uploads its files and moves the channel pointer. */
    build: (release: { change: string, seq: number, version: string }) => Promise<CoreRelease>
    changes: ReleaseChange[]
    /** Releases that exist before the console starts, for example the builtin core. */
    history?: ReleaseEntry[]
    /** Called after the history changes, so the host can keep it. */
    onHistoryChange?: (history: ReleaseEntry[]) => void
  }
  signingKey: SigningKey
  tree: MemoryTree
}

/** One kind of release that the console offers, for example a page-only change. */
export interface ReleaseChange {
  id: string
  label: string
}

/** One published release in the console history. */
export interface ReleaseEntry {
  change: string
  channel: string
  publishedAt: string
  rollout: number
  seq: number
  version: string
}

const CADENCE = 'realtime'

/**
 * Serves a tree in memory with a small release console for local tests and demos.
 *
 * The console publishes a release to a channel and revokes a release. It lists the history and shows what the app
 * runs, including releases that the server does not know.
 */
export async function createDevServer(options: DevServerOptions): Promise<DevServer> {
  const { product, signingKey, tree } = options
  let faults: Faults = { ...NO_FAULTS, ...options.faults }
  let clientState: ClientReport | undefined
  const streams = new Set<ServerResponse>()
  const channels = options.channels ?? ['canary', 'stable']
  const history: ReleaseEntry[] = [...options.release?.history ?? []]

  const broadcast = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const stream of streams)
      stream.write(message)
  }

  const pointerOf = (channel: string): Pointer | undefined => {
    const file = tree.get(`pointers/${channel}/${CADENCE}.json`)

    return file && JSON.parse(new TextDecoder().decode(file.bytes)) as Pointer
  }
  const pointers = () => channels.map(pointerOf).filter((pointer): pointer is Pointer => pointer !== undefined)

  const snapshot = () => ({
    changes: options.release?.changes ?? [],
    channels,
    clientState,
    history,
    nextVersion: suggestVersion(history, clientState),
    pointers: pointers(),
  })

  /** Builds a channel pointer again from its current content after `change` edits it. */
  const writePointer = async (channel: string, change: (pointer: { core?: number, revoked: number[], rollout?: number }) => void) => {
    const current = pointerOf(channel)
    const next = { core: current?.core?.seq, revoked: [...current?.revoked ?? []], rollout: current?.core?.rollout?.percentage }
    change(next)
    const built = await buildPointer({
      cadence: CADENCE,
      channel,
      core: next.core === undefined ? undefined : { cohorts: current?.core?.cohorts, rollout: next.rollout, seq: next.core },
      // A client rejects a pointer older than one it accepted, so keep issue times increasing.
      issuedAt: new Date(Math.max(Date.now(), current ? Date.parse(current.issuedAt) + 1 : 0)).toISOString(),
      product,
      revoked: next.revoked,
      signingKey,
    })
    tree.put(built.files)
  }

  const handlers = {
    async faults(body: Partial<Faults>) {
      faults = { ...NO_FAULTS, ...body }

      return faults
    },
    async publish(body: { change: string, channel?: string, rollout?: number, version: string }) {
      if (!options.release)
        throw new Error('This server has no build function.')
      if (!options.release.changes.some(change => change.id === body.change))
        throw new Error(`Unknown change ${body.change}.`)

      const version = body.version.trim()
      if (!version)
        throw new Error('The version is empty.')
      if (history.some(entry => entry.version === version))
        throw new Error(`Version ${version} is already published.`)

      const channel = body.channel ?? channels[0]!
      const rollout = body.rollout ?? 100
      // The history can hold releases that the tree lost, for example after a restore.
      const seq = createSeq(Math.max(0, ...history.map(entry => entry.seq)))
      const release = await options.release.build({ change: body.change, seq, version })
      tree.put(uploadStages([release]).flat())
      await writePointer(channel, (pointer) => {
        pointer.core = release.seq
        pointer.rollout = rollout
      })
      history.push({ change: body.change, channel, publishedAt: new Date().toISOString(), rollout, seq: release.seq, version })
      options.release.onHistoryChange?.(history)

      return { seq: release.seq, version }
    },
    /** Signs every pointer again, for example after the tree went back to a backup and clients ignore its pointers. */
    async reissue() {
      for (const pointer of pointers())
        await writePointer(pointer.channel, () => {})
    },
    async revoke(body: { seq: number }) {
      for (const pointer of pointers()) {
        await writePointer(pointer.channel, (next) => {
          if (!next.revoked.includes(body.seq))
            next.revoked.push(body.seq)
          if (next.core === body.seq) {
            // Serve the newest earlier release that is not revoked, or no core.
            next.core = history.filter(entry => entry.seq < body.seq && !next.revoked.includes(entry.seq)).at(-1)?.seq
            next.rollout = 100
          }
        })
      }
    },
  }

  const routes = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> => {
    if (path === '/' || path === '/_console') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(consolePage)

      return true
    }
    if (!path.startsWith('/_api/'))
      return false

    const name = path.slice('/_api/'.length)
    try {
      if (name === 'state' && request.method === 'GET') {
        sendJson(response, 200, snapshot())
      }
      else if (name === 'events' && request.method === 'GET') {
        response.writeHead(200, { 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'Content-Type': 'text/event-stream' })
        response.write(': connected\n\n')
        streams.add(response)
        request.on('close', () => streams.delete(response))
      }
      else if (request.method === 'POST' && Object.hasOwn(handlers, name)) {
        // The body comes from the console page. Each handler reads the fields it needs.
        const handle = handlers[name as keyof typeof handlers] as (body: unknown) => Promise<unknown>
        const result = await handle(await readBody(request))
        broadcast('state', snapshot())
        sendJson(response, 200, { ok: true, result })
      }
      else {
        sendJson(response, 404, { error: 'No such route.' })
      }
    }
    catch (error) {
      sendJson(response, 400, { error: errorMessageFrom(error) ?? 'The request failed.' })
    }

    return true
  }

  if (!pointerOf(channels[0]!))
    await writePointer(channels[0]!, () => {})

  const server = await createTreeServer({ faults: () => faults, host: options.host, port: options.port, routes, tree })

  return {
    ...server,
    async close() {
      for (const stream of streams)
        stream.end()
      await server.close()
    },
    consoleUrl: `${server.url}/_console`,
    setClientState(state) {
      clientState = state
      broadcast('client-state', state)
    },
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(chunk as Buffer)

  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

/**
 * Suggests the next version: the last version with its last number increased.
 *
 * When the app runs a release that the history does not hold, for example after the server went back to a backup, the
 * suggestion starts from the version of the app. The next release must be newer than what the app has.
 */
function suggestVersion(history: readonly ReleaseEntry[], client?: ClientReport): string {
  const newest = history.at(-1)
  const appIsAhead = client?.runningVersion !== undefined && client.running !== undefined && client.running > (newest?.seq ?? 0)
  const last = appIsAhead ? client.runningVersion! : (newest?.version ?? '1.0.0')
  const match = /(\d+)(\D*)$/.exec(last)

  return match ? `${last.slice(0, match.index)}${Number(match[1]) + 1}${match[2]}` : `${last}.1`
}
