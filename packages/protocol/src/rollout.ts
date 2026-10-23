import type { Rollout } from './schema'

/** An install is in a rollout when its bucket is less than the percentage. No rollout means everyone. */
export async function isInRollout(rollout: Rollout | undefined, installId: string): Promise<boolean> {
  if (!rollout)
    return true

  return await rolloutBucket(rollout.salt, installId) < rollout.percentage
}

/**
 * Returns the rollout bucket of an install, from 0 to 99.
 *
 * The bucket is the first 4 bytes of `sha256(salt + ":" + installId)` as a big-endian integer, mod 100.
 */
export async function rolloutBucket(salt: string, installId: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${installId}`))
  const value = new DataView(digest, 0, 4).getUint32(0, false)

  return value % 100
}
