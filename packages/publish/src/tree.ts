// The default layout of the update tree: the keys and the headers of each file. The publish API and the file tree store
// use it. It is internal, so integrations work with typed releases and do not depend on the layout.

import type { SignedDocument } from '@ergosphere-it/protocol'

import type { BundleObject, InstallerFeed, InstallerFileUpload, TreeFile } from './index'

const IMMUTABLE = 'public, max-age=31536000, immutable'
const NO_STORE = 'no-store'

/** The files of a signed bundle manifest in the tree: `bundles/<releaseId>/bundle.json` and its signature. */
export function bundleTreeFiles(releaseId: number, signed: SignedDocument): TreeFile[] {
  return documentFiles(`bundles/${releaseId}/bundle.json`, signed, true)
}

/** The key of a channel file in the tree: `channels/<channel>.json`. Its signature is at the key plus `.sig`. */
export function channelKey(channel: string): string {
  return `channels/${channel}.json`
}

/** The files of a signed channel file in the tree: `channels/<channel>.json` and its signature. They are never cached. */
export function channelTreeFiles(channel: string, signed: SignedDocument): TreeFile[] {
  return documentFiles(channelKey(channel), signed, false)
}

/**
 * The file of an installer feed in the tree: `installers/<releaseId>/feeds/<platform>/<name>` for electron-updater, and
 * `installers/<releaseId>/sparkle/<platform>/appcast.xml` for Sparkle.
 */
export function feedTreeFile(releaseId: number, feed: InstallerFeed): TreeFile {
  const dir = feed.format === 'sparkle' ? 'sparkle' : 'feeds'

  return treeFile(`installers/${releaseId}/${dir}/${feed.platform}/${feed.name}`, feed.bytes, feed.contentType, true)
}

/** The file of a hosted installer file in the tree: `installers/<releaseId>/files/<name>`. It never changes. */
export function installerFileTreeFile(file: InstallerFileUpload): TreeFile {
  return treeFile(`installers/${file.releaseId}/files/${file.name}`, file.bytes, 'application/octet-stream', true)
}

/** The files of a signed installer manifest in the tree: `installers/<releaseId>/installer.json` and its signature. */
export function installerTreeFiles(releaseId: number, signed: SignedDocument): TreeFile[] {
  return documentFiles(`installers/${releaseId}/installer.json`, signed, true)
}

/** The key of an object in the tree: `objects/sha256/<aa>/<sha256>`. */
export function objectKey(sha256: string): string {
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256}`
}

/** The file of an object in the tree. It never changes, so it is cached forever. */
export function objectTreeFile(object: BundleObject): TreeFile {
  return treeFile(objectKey(object.sha256), object.bytes, 'application/octet-stream', true)
}

function documentFiles(key: string, { bytes, signature }: SignedDocument, immutable: boolean): TreeFile[] {
  return [
    treeFile(key, bytes, 'application/json', immutable),
    treeFile(`${key}.sig`, new TextEncoder().encode(signature) as Uint8Array<ArrayBuffer>, 'text/plain', immutable),
  ]
}

function treeFile(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string, immutable: boolean): TreeFile {
  return { bytes, headers: { 'Cache-Control': immutable ? IMMUTABLE : NO_STORE, 'Content-Type': contentType }, immutable, key }
}
