import type { BundleManifest, ChannelFile, InstallerManifest, SignedDocument } from '@ergosphere-it/protocol'

import type { BundleObject, InstallerFeed } from './index'

/**
 * Where a publisher keeps releases. The publisher calls it with typed releases, and it stores them in any way: the
 * default layout in a bucket, or the API of a release server. It runs in CI. An app never loads it: the app reads the
 * files from `feedUrl`, or from where its locator says.
 *
 * Make one with `createReleaseStore`, or with `createFileTreeStore` for the default layout. Every store keeps these rules:
 *
 * - It keeps the bytes and the signature of each document exactly, and never serializes the document again.
 * - A write is complete when its promise resolves. The publisher writes objects, then manifests, then the channel file,
 *   so an app never reads a channel file that names files the store does not have yet.
 * - `getChannel` returns the newest channel file. The publisher verifies it, changes it, and signs it again.
 */
export interface ReleaseStore {
  /** Returns the bytes and the signature of a channel file, or `undefined` when the channel does not exist. */
  getChannel: (channel: string) => Promise<StoredDocument | undefined>
  /** Whether the store has an object. The publisher uploads only the objects that the store does not have. */
  hasObject: (sha256: string) => Promise<boolean>
  /** Lists the names of the channels. Only `withdraw` without `--channel` uses it. */
  listChannels?: () => Promise<string[]>
  /** Names the store in messages. */
  name: string
  putBundle: (bundle: Signed<BundleManifest>) => Promise<void>
  /**
   * Stores a channel file. `expected` is what `getChannel` returned before the publisher built `next`. A store that can
   * compare and set throws a `ChannelConflictError` when the stored file is not `expected` any more, for example when
   * its signature differs. The publisher then reads the channel again, changes it again, and signs it again, up to 5
   * times.
   */
  putChannel: (next: Signed<ChannelFile>, expected: StoredDocument | undefined) => Promise<void>
  /**
   * Stores an installer manifest, and the files that installers read: electron-updater feeds and Sparkle appcasts.
   * Store the feeds before the manifest, so a client that reads the manifest finds them.
   */
  putInstaller: (installer: Signed<InstallerManifest> & { feeds: InstallerFeed[] }) => Promise<void>
  putObject: (object: BundleObject) => Promise<void>
}

/** The callbacks of a store. `hasObject`, `listChannels`, and `name` are optional. */
export type ReleaseStoreCallbacks = Omit<ReleaseStore, 'hasObject' | 'name'> & Partial<Pick<ReleaseStore, 'hasObject' | 'name'>>

/** A signed document: its exact bytes and signature, and the parsed document to index. */
export interface Signed<T> extends SignedDocument {
  document: T
}

/**
 * The bytes and the signature of a stored document, as a store gives them back. The bytes can be any `Uint8Array`, for
 * example from `Uint8Array.fromBase64`. The signature is base64 text, as in the `.sig` file of the default layout.
 */
export interface StoredDocument {
  bytes: Uint8Array
  signature: string
}

/** A store throws it from `putChannel` when another publish changed the channel after the publisher read it. */
export class ChannelConflictError extends Error {
  readonly channel: string

  constructor(channel: string) {
    super(`ergosphere-it: channel ${channel} changed while the publisher changed it.`)
    this.channel = channel
    this.name = 'ChannelConflictError'
  }
}

const REQUIRED = ['getChannel', 'putBundle', 'putChannel', 'putInstaller', 'putObject'] as const

/**
 * Creates a release store from callbacks, for example calls to the API of your release server. It checks that the
 * required callbacks exist, and fills the defaults: without `hasObject`, the publisher uploads every object, and without
 * `listChannels`, `withdraw` needs `--channel`.
 */
export function createReleaseStore(callbacks: ReleaseStoreCallbacks): ReleaseStore {
  const missing = REQUIRED.filter(name => typeof callbacks[name] !== 'function')
  if (missing.length > 0)
    throw new TypeError(`ergosphere-it: the release store has no ${missing.join(', ')}.`)

  return { hasObject: async () => false, name: 'the release store', ...callbacks }
}

/** Whether a store rejected a channel write for a change of another publish. */
export function isChannelConflict(error: unknown): boolean {
  // Two copies of this module can load, for example one in the CLI and one in a config file, so the name counts too.
  return error instanceof ChannelConflictError || (error instanceof Error && error.name === 'ChannelConflictError')
}

/** Whether a value has the callbacks of a {@link ReleaseStore}. */
export function isReleaseStore(value: unknown): value is ReleaseStore {
  const store = value as Partial<ReleaseStore> | undefined

  return REQUIRED.every(name => typeof store?.[name] === 'function') && typeof store?.hasObject === 'function' && typeof store.name === 'string'
    && (store.listChannels === undefined || typeof store.listChannels === 'function')
}
