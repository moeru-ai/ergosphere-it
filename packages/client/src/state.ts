import type { InferOutput } from 'valibot'

import type { UpdateFileSystem } from './io'

import { array, boolean, integer, minValue, number, object, optional, picklist, pipe, record, safeParse, string } from 'valibot'

const releaseIdSchema = pipe(number(), integer(), minValue(1))

/** A bundle by its release and version. `fromInstaller` marks the bundle of the installer. */
const bundleRefSchema = object({
  fromInstaller: boolean(),
  releaseId: releaseIdSchema,
  version: string(),
})

const clientStateSchema = object({
  blocked: array(releaseIdSchema),
  /** Boots without a healthy report, by bundle key: a release ID, or `installer`. */
  bootAttempts: record(string(), pipe(number(), integer(), minValue(0))),
  /** The newest channel file `issuedAt` that this install accepted, by channel. */
  channelIssuedAt: optional(record(string(), string())),
  current: optional(releaseIdSchema),
  /** A staged bundle that waits for a newer native version. */
  deferred: optional(releaseIdSchema),
  installId: string(),
  previous: optional(releaseIdSchema),
  /**
   * The last rollback, so the app can tell the user after a restart. It stays until the app dismisses it or a newer
   * bundle is staged.
   */
  rolledBack: optional(object({
    from: bundleRefSchema,
    reason: picklist(['crashed-at-launch', 'not-marked-healthy', 'withdrawn']),
    to: bundleRefSchema,
  })),
  staged: optional(releaseIdSchema),
  /** Bundles that a channel file withdrew. They are also in `blocked`. */
  withdrawn: array(releaseIdSchema),
})

export type BundleRef = NonNullable<ClientState['rolledBack']>['from']
export type ClientState = InferOutput<typeof clientStateSchema>
export type RollbackReason = NonNullable<ClientState['rolledBack']>['reason']

/** Loads the state file. A missing or damaged file gives a fresh state, so the client falls back to the installer bundle. */
export async function loadState(fs: UpdateFileSystem, path: string): Promise<ClientState> {
  const bytes = await fs.readFile(path)
  if (!bytes)
    return createInitialState()

  try {
    const parsed = safeParse(clientStateSchema, JSON.parse(new TextDecoder().decode(bytes)))
    if (parsed.success)
      return parsed.output
  }
  catch {}

  return createInitialState()
}

export async function saveState(fs: UpdateFileSystem, path: string, state: ClientState): Promise<void> {
  await fs.writeFileAtomic(path, new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`))
}

function createInitialState(): ClientState {
  return { blocked: [], bootAttempts: {}, installId: crypto.randomUUID(), withdrawn: [] }
}
