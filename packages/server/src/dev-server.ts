import type { ChannelFile, SigningKey } from '@ergosphere-it/protocol'
import type { BundleRelease } from '@ergosphere-it/publish'
import type { Context } from 'hono'
import type { SSEStreamingApi } from 'hono/streaming'
import type { GenericSchema, InferOutput } from 'valibot'

import type { MemoryTree } from './tree'
import type { Faults, TreeServer } from './tree-server'

import { buildChannelFile, createReleaseId, uploadStages } from '@ergosphere-it/publish'
import { errorMessageFrom } from '@moeru/std/error'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { boolean, integer, maxValue, minValue, number, object, optional, partial, pipe, regex, safeParse, string, summarize } from 'valibot'

import { consolePage } from './console-page'
import { createTreeApp, listen, NO_FAULTS } from './tree-server'

/** What the host reports about the app. The console uses it to show desyncs between the app and the server. */
export interface ClientReport {
  /** Bundles that the app blocked after failures. */
  blocked?: number[]
  /** The result of the last update check of the app, for example `{ status: 'up-to-date', detail: 'app-newer-than-feed' }`. */
  lastCheck?: { [key: string]: unknown, code?: string, detail?: string, status: string }
  pid?: number
  /** The release ID of the bundle that the app runs. */
  running?: number
  /** The version of the bundle that the app runs, from its manifest. */
  runningVersion?: string
}

export interface DevServer extends TreeServer {
  /** The URL of the console page. */
  consoleUrl: string
  /** Shows the state of a client in the console, for example the bundle it runs and the bundles it blocked. */
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
  /** How the console publishes. Without it, the console can still withdraw what the tree holds. */
  release?: {
    /** Builds a release. The server uploads its files and moves the channel to it. */
    build: (release: { change: string, releaseId: number, version: string }) => Promise<BundleRelease>
    changes: ReleaseChange[]
    /** Releases that exist before the console starts, for example the bundle of the installer. */
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
  releaseId: number
  rollout: number
  version: string
}

/** A console request that cannot run, for example a version that is already published. The console shows its message. */
export class ReleaseRequestError extends Error {
  override name = 'ReleaseRequestError'
}

// Channel names become file paths and page text, so they stay plain.
const channelSchema = pipe(string(), regex(/^[\w.-]+$/, 'A channel name has only letters, digits, `.`, `_`, and `-`.'))
const percentSchema = pipe(number(), minValue(0), maxValue(100))
const faultsSchema = partial(object({
  bytesPerSecond: pipe(number(), minValue(0)),
  dropRate: percentSchema,
  errorRate: percentSchema,
  hideChannelFiles: boolean(),
  latencyMs: pipe(number(), minValue(0)),
  tamperObjects: boolean(),
}))
const publishSchema = object({
  change: string(),
  channel: optional(channelSchema),
  rollout: optional(pipe(percentSchema, integer())),
  version: string(),
})
const withdrawSchema = object({ releaseId: pipe(number(), integer(), minValue(1)) })

/**
 * Serves a tree in memory with a small release console for local tests and demos.
 *
 * The console publishes a release to a channel and withdraws a release. It lists the history and shows what the app
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

  for (const channel of channels) {
    if (!/^[\w.-]+$/.test(channel))
      throw new Error(`The channel name ${JSON.stringify(channel)} has characters other than letters, digits, ".", "_", and "-".`)
  }

  const channelFileOf = (channel: string): ChannelFile | undefined => {
    const file = tree.get(`channels/${channel}.json`)

    return file && JSON.parse(new TextDecoder().decode(file.bytes)) as ChannelFile
  }
  const channelFiles = () => channels.map(channelFileOf).filter((file): file is ChannelFile => file !== undefined)

  const snapshot = () => ({
    changes: options.release?.changes ?? [],
    channelFiles: channelFiles(),
    channels,
    clientState,
    history,
    nextVersion: suggestVersion(history, clientState),
  })

  /** Builds a channel file again from its current content after `change` edits it. It keeps every other field. */
  const writeChannelFile = async (channel: string, change: (file: { bundle?: number, rollout?: number, withdrawn: number[] }) => void) => {
    const current = channelFileOf(channel)
    const next = { bundle: current?.bundle?.releaseId, rollout: current?.bundle?.rollout?.percentage, withdrawn: [...current?.withdrawn ?? []] }
    change(next)
    // A new bundle gets new rollout buckets. The same bundle keeps its salt, so installs stay in their buckets.
    const salt = next.bundle === current?.bundle?.releaseId ? current?.bundle?.rollout?.salt : undefined
    const built = await buildChannelFile({
      bundle: next.bundle === undefined ? undefined : { cohorts: current?.bundle?.cohorts, releaseId: next.bundle, rollout: next.rollout, salt },
      channel,
      installer: current?.installer,
      // A client rejects a channel file older than one it accepted, so keep issue times increasing.
      issuedAt: new Date(Math.max(Date.now(), current ? Date.parse(current.issuedAt) + 1 : 0)).toISOString(),
      product,
      signingKey,
      withdrawn: next.withdrawn,
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
      if (!channels.includes(channel))
        throw new ReleaseRequestError(`Unknown channel ${channel}.`)
      const releaseId = createReleaseId(Math.max(0, ...history.map(entry => entry.releaseId)))
      const release = await options.release.build({ change: body.change, releaseId, version })
      tree.put(uploadStages([release]).flat())
      await writeChannelFile(channel, (file) => {
        file.bundle = release.releaseId
        file.rollout = rollout
      })
      history.push({ change: body.change, channel, publishedAt: new Date().toISOString(), releaseId: release.releaseId, rollout, version })
      options.release.onHistoryChange?.(history)

      return { releaseId: release.releaseId, version }
    }))
    // Signs every channel file again, for example after the tree went back to a backup and clients ignore its files.
    .post('/_api/reissue', async (c) => {
      for (const file of channelFiles())
        await writeChannelFile(file.channel, () => {})
      broadcast('state', snapshot())

      return c.json({ ok: true })
    })
    .post('/_api/withdraw', action(withdrawSchema, async ({ releaseId }) => {
      for (const file of channelFiles()) {
        await writeChannelFile(file.channel, (next) => {
          if (!next.withdrawn.includes(releaseId))
            next.withdrawn.push(releaseId)
          if (next.bundle === releaseId) {
            // Serve the newest earlier release of this channel that is not withdrawn, or no bundle.
            next.bundle = history.filter(entry => entry.channel === file.channel && entry.releaseId < releaseId && !next.withdrawn.includes(entry.releaseId)).at(-1)?.releaseId
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

  if (!channelFileOf(channels[0]!))
    await writeChannelFile(channels[0]!, () => {})

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
  const appIsAhead = client?.runningVersion !== undefined && client.running !== undefined && client.running > (newest?.releaseId ?? 0)
  const last = appIsAhead ? client.runningVersion! : (newest?.version ?? '1.0.0')
  const match = /(\d+)(\D*)$/.exec(last)

  return match ? `${last.slice(0, match.index)}${Number(match[1]) + 1}${match[2]}` : `${last}.1`
}
