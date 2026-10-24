import type { InferOutput } from 'valibot'

import type { UpdateFileSystem } from './io'

import { array, integer, minValue, number, object, optional, pipe, record, safeParse, string } from 'valibot'

const seqSchema = pipe(number(), integer(), minValue(1))

const clientStateSchema = object({
  blocked: array(seqSchema),
  /** Boots without a healthy report, by core key: a seq, or `builtin`. */
  bootAttempts: record(string(), pipe(number(), integer(), minValue(0))),
  current: optional(seqSchema),
  /** A staged core that waits for a newer shell. */
  deferred: optional(seqSchema),
  installId: string(),
  /** The newest pointer `issuedAt` that this install accepted, by `<channel>/<cadence>`. */
  pointerIssuedAt: optional(record(string(), string())),
  previous: optional(seqSchema),
  staged: optional(seqSchema),
})

export type ClientState = InferOutput<typeof clientStateSchema>

/** Loads the state file. A missing or damaged file gives a fresh state, so the client falls back to the builtin core. */
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
  return { blocked: [], bootAttempts: {}, installId: crypto.randomUUID() }
}
