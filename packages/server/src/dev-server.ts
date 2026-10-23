import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Cadence } from '@ergosphere-it/protocol'
import type { SigningKey } from '@ergosphere-it/publish'

import type { Faults, StaticServer } from './index'

import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'

import { nextSeq, readPointer, readTree, reissuePointers, writePointer } from '@ergosphere-it/publish'
import { errorMessageFrom } from '@moeru/std/error'

import { consolePage } from './console-page'
import { createStaticServer, NO_FAULTS } from './index'

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

export interface DevServer extends StaticServer {
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
  key: SigningKey
  port?: number
  product: string
  /** How the console publishes. Without it, the console can still serve and revoke what the tree holds. */
  release?: {
    changes: ReleaseChange[]
    /** Releases that exist before the console starts, for example the builtin core. */
    history?: ReleaseEntry[]
    /** Keeps the history in this file, so it survives a restart of the server. */
    historyFile?: string
    /** Writes the core of a release into the tree. The server then moves the channel pointer. */
    publish: (release: { change: string, seq: number, version: string }) => Promise<void>
  }
  root: string
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

const CADENCE: Cadence = 'realtime'

/**
 * Serves an update tree with a small release console for local tests and demos.
 *
 * The console publishes a release to a channel, serves an earlier release again, and revokes a release. It lists the
 * history and shows what the app runs.
 */
export async function createDevServer(options: DevServerOptions): Promise<DevServer> {
  let faults: Faults = { ...NO_FAULTS, ...options.faults }
  let clientState: ClientReport | undefined
  const streams = new Set<ServerResponse>()
  const channels = options.channels ?? ['canary', 'stable']
  const historyFile = options.release?.historyFile
  const history: ReleaseEntry[] = await readHistory(historyFile) ?? [...options.release?.history ?? []]
  const saveHistory = async () => {
    if (historyFile)
      await writeFile(historyFile, `${JSON.stringify(history, null, 2)}\n`)
  }

  const broadcast = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const stream of streams)
      stream.write(message)
  }

  const snapshot = async () => ({
    changes: options.release?.changes ?? [],
    channels,
    clientState,
    history,
    nextVersion: suggestVersion(history, clientState),
    pointers: (await readTree(options.root)).pointers,
  })

  const updatePointer = async (channel: string, change: (pointer: { core?: number, revoked: number[], rollout?: number }) => void) => {
    const current = await readPointer(options.root, channel, CADENCE)
    const next = { core: current?.core?.seq, revoked: [...current?.revoked ?? []], rollout: current?.core?.rollout?.percentage }
    change(next)
    await writePointer({
      cadence: CADENCE,
      channel,
      coreSeq: next.core,
      key: options.key,
      product: options.product,
      revoked: next.revoked,
      rollout: next.core !== undefined && next.rollout !== undefined && next.rollout < 100 ? { percentage: next.rollout, salt: String(next.core) } : undefined,
      tree: options.root,
    })
  }

  const handlers = {
    async faults(body: Partial<Faults>) {
      faults = { ...NO_FAULTS, ...body }

      return faults
    },
    /** Low-level pointer write, for tests and scripts. */
    async pointer(body: { cadence: Cadence, channel: string, cohorts?: string[], core?: number, revoked?: number[], rollout?: number }) {
      await writePointer({
        cadence: body.cadence,
        channel: body.channel,
        cohorts: body.cohorts?.length ? body.cohorts : undefined,
        coreSeq: body.core,
        key: options.key,
        product: options.product,
        revoked: body.revoked,
        rollout: body.core !== undefined && body.rollout !== undefined && body.rollout < 100 ? { percentage: body.rollout, salt: String(body.core) } : undefined,
        tree: options.root,
      })
    },
    async publish(body: { change: string, channel?: string, rollout?: number, version: string }) {
      if (!options.release)
        throw new Error('this server has no publish function')
      if (!options.release.changes.some(change => change.id === body.change))
        throw new Error(`unknown change ${body.change}`)

      const version = body.version.trim()
      if (!version)
        throw new Error('the version is empty')
      if (history.some(entry => entry.version === version))
        throw new Error(`version ${version} is already published`)

      const channel = body.channel ?? channels[0]!
      const rollout = body.rollout ?? 100
      // The history can hold releases that are not in the tree, for example the builtin core.
      const seq = Math.max(await nextSeq(options.root), ...history.map(entry => entry.seq + 1))
      await options.release.publish({ change: body.change, seq, version })
      await updatePointer(channel, (pointer) => {
        pointer.core = seq
        pointer.rollout = rollout
      })
      history.push({ change: body.change, channel, publishedAt: new Date().toISOString(), rollout, seq, version })
      await saveHistory()

      return { seq, version }
    },
    /** Signs every pointer again, for example after the tree went back to a backup and clients ignore its pointers. */
    async reissue() {
      return reissuePointers({ key: options.key, product: options.product, tree: options.root })
    },
    async revoke(body: { seq: number }) {
      for (const channel of channels) {
        if (!await readPointer(options.root, channel, CADENCE))
          continue

        await updatePointer(channel, (pointer) => {
          if (!pointer.revoked.includes(body.seq))
            pointer.revoked.push(body.seq)
          if (pointer.core === body.seq) {
            // Serve the newest earlier release that is not revoked, or no core.
            pointer.core = history
              .filter(entry => entry.seq < body.seq && !pointer.revoked.includes(entry.seq))
              .at(-1)
              ?.seq
            pointer.rollout = 100
          }
        })
      }
    },
    async serve(body: { channel: string, seq: number }) {
      await updatePointer(body.channel, (pointer) => {
        pointer.core = body.seq
        pointer.rollout = 100
        pointer.revoked = pointer.revoked.filter(seq => seq !== body.seq)
      })
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
        sendJson(response, 200, await snapshot())
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
        broadcast('state', await snapshot())
        sendJson(response, 200, { ok: true, result })
      }
      else {
        sendJson(response, 404, { error: 'no such route' })
      }
    }
    catch (error) {
      sendJson(response, 400, { error: errorMessageFrom(error) ?? 'request failed' })
    }

    return true
  }

  const server = await createStaticServer({ faults: () => faults, host: options.host, port: options.port, root: options.root, routes })

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

async function readHistory(file: string | undefined): Promise<ReleaseEntry[] | undefined> {
  if (!file)
    return undefined

  try {
    return JSON.parse(await readFile(file, 'utf8')) as ReleaseEntry[]
  }
  catch {
    return undefined
  }
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
