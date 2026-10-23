import type { InferOutput } from 'valibot'

import type { UpdateFileSystem } from './io'

import { array, integer, minValue, number, object, optional, pipe, record, safeParse, string } from 'valibot'

const seqSchema = pipe(number(), integer(), minValue(1))

export const clientStateSchema = object({
  installId: string(),
  staged: optional(seqSchema),
  current: optional(seqSchema),
  previous: optional(seqSchema),
  /** A staged core that waits for a newer shell. */
  deferred: optional(seqSchema),
  blocked: array(seqSchema),
  lastPointerIssuedAt: optional(string()),
  /** Boots without a healthy report, by core key: a seq, or `builtin`. */
  bootAttempts: record(string(), pipe(number(), integer(), minValue(0))),
})

export type ClientState = InferOutput<typeof clientStateSchema>

export function createInitialState(): ClientState {
  return { installId: crypto.randomUUID(), blocked: [], bootAttempts: {} }
}

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
