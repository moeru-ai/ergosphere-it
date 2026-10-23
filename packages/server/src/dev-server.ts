import type { Pointer, SigningKey } from '@ergosphere-it/protocol'
import type { CoreRelease } from '@ergosphere-it/publish'
import type { Context } from 'hono'
import type { SSEStreamingApi } from 'hono/streaming'
import type { GenericSchema, InferOutput } from 'valibot'

import type { MemoryTree } from './tree'
import type { Faults, TreeServer } from './tree-server'

import { buildPointer, createSeq, uploadStages } from '@ergosphere-it/publish'
import { errorMessageFrom } from '@moeru/std/error'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { boolean, integer, maxValue, minValue, number, object, optional, partial, pipe, safeParse, string, summarize } from 'valibot'

import { consolePage } from './console-page'
import { createTreeApp, listen, NO_FAULTS } from './tree-server'

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

/** A console request that cannot run, for example a version that is already published. The console shows its message. */
export class ReleaseRequestError extends Error {
  override name = 'ReleaseRequestError'
}

const percentSchema = pipe(number(), minValue(0), maxValue(100))
const faultsSchema = partial(object({
  bytesPerSecond: pipe(number(), minValue(0)),
  dropRate: percentSchema,
  errorRate: percentSchema,
  hidePointers: boolean(),
  latencyMs: pipe(number(), minValue(0)),
  tamperObjects: boolean(),
}))
const publishSchema = object({
  change: string(),
  channel: optional(string()),
  rollout: optional(pipe(percentSchema, integer())),
  version: string(),
})
const revokeSchema = object({ seq: pipe(number(), integer(), minValue(1)) })

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
  const streams = new Set<SSEStreamingApi>()
  const channels = options.channels ?? ['canary', 'stable']
  const history: ReleaseEntry[] = [...options.release?.history ?? []]

  const broadcast = (event: string, data: unknown) => {
    for (const stream of streams)
      void stream.writeSSE({ data: JSON.stringify(data), event })
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

  /** Runs a console action with a validated body, then sends the new state to every console. */
  const action = <Schema extends GenericSchema>(schema: Schema, run: (body: InferOutput<Schema>) => Promise<unknown>) => async (c: Context) => {
    const parsed = safeParse(schema, await c.req.json().catch(() => undefined))
    if (!parsed.success)
      throw new ReleaseRequestError(summarize(parsed.issues))

    const result = await run(parsed.output)
    broadcast('state', snapshot())

    return c.json({ ok: true, result })
  }

  const app = new Hono()
    .get('/', c => c.html(consolePage))
    .get('/_console', c => c.html(consolePage))
    .get('/_api/state', c => c.json(snapshot()))
    .get('/_api/events', c => streamSSE(c, async (stream) => {
      streams.add(stream)
      await new Promise<void>(resolve => stream.onAbort(resolve))
      streams.delete(stream)
    }))
    .post('/_api/faults', action(faultsSchema, async (body) => {
      faults = { ...NO_FAULTS, ...body }

      return faults
    }))
    .post('/_api/publish', action(publishSchema, async (body) => {
      if (!options.release)
        throw new ReleaseRequestError('This server has no build function.')
      if (!options.release.changes.some(change => change.id === body.change))
        throw new ReleaseRequestError(`Unknown change ${body.change}.`)

      const version = body.version.trim()
      if (!version)
        throw new ReleaseRequestError('The version is empty.')
      if (history.some(entry => entry.version === version))
        throw new ReleaseRequestError(`Version ${version} is already published.`)

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
    }))
    // Signs every pointer again, for example after the tree went back to a backup and clients ignore its pointers.
    .post('/_api/reissue', async (c) => {
      for (const pointer of pointers())
        await writePointer(pointer.channel, () => {})
      broadcast('state', snapshot())

      return c.json({ ok: true })
    })
    .post('/_api/revoke', action(revokeSchema, async ({ seq }) => {
      for (const pointer of pointers()) {
        await writePointer(pointer.channel, (next) => {
          if (!next.revoked.includes(seq))
            next.revoked.push(seq)
          if (next.core === seq) {
            // Serve the newest earlier release that is not revoked, or no core.
            next.core = history.filter(entry => entry.seq < seq && !next.revoked.includes(entry.seq)).at(-1)?.seq
            next.rollout = 100
          }
        })
      }
    }))
    .all('/_api/*', c => c.json({ error: 'No such route.' }, 404))
    .route('/', createTreeApp({ faults: () => faults, tree }))
    .onError((error, c) => c.json(
      { error: errorMessageFrom(error) ?? 'The request failed.' },
      error instanceof ReleaseRequestError ? 400 : 500,
    ))

  if (!pointerOf(channels[0]!))
    await writePointer(channels[0]!, () => {})

  const server = await listen(app, { host: options.host, port: options.port })

  return {
    ...server,
    async close() {
      for (const stream of streams)
        await stream.close()
      await server.close()
    },
    consoleUrl: `${server.url}/_console`,
    setClientState(state) {
      // Hosts report on a timer. Send only a change, so the console does not render for nothing.
      if (JSON.stringify(state) === JSON.stringify(clientState))
        return

      clientState = state
      broadcast('client-state', state)
    },
  }
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
