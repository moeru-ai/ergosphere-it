/**
 * Where a file is: its URL, or its URL and, for a document, the URL of its detached signature. `signatureUrl` defaults
 * to the URL of the document plus `.sig`.
 */
export type FileLocation = string | { signatureUrl?: string, url: string }

/**
 * A file of the protocol that the client fetches. The specification defines these kinds, so every host and every client
 * language has them. A host adds the files of its own installers.
 */
export type FileRef
  = | { channel: string, kind: 'channel' }
    | { kind: 'bundle', releaseId: number }
    | { kind: 'installer', releaseId: number }
    | { kind: 'object', releaseId: number, sha256: string, size: number }

/**
 * Tells the client where a file is. A location carries no trust: the client verifies every document with the trusted
 * keys, and every object with the SHA-256 and the size of its signed manifest. So a locator can give any URL, for
 * example a signed CDN URL that a release server hands out. A bad locator can only stop updates.
 */
export type Locator<Ref = FileRef> = (ref: Ref) => FileLocation | Promise<FileLocation>

/** Creates the locator of the file tree of the specification under `feedUrl`. The client uses it by default. */
export function createTreeLocator(feedUrl: string): Locator {
  const base = feedUrl.replace(/\/+$/, '')

  return (ref) => {
    switch (ref.kind) {
      case 'bundle':
        return `${base}/bundles/${ref.releaseId}/bundle.json`
      case 'channel':
        return `${base}/channels/${ref.channel}.json`
      case 'installer':
        return `${base}/installers/${ref.releaseId}/installer.json`
      case 'object':
        return `${base}/objects/sha256/${ref.sha256.slice(0, 2)}/${ref.sha256}`
    }
  }
}

/**
 * Types a locator callback, for example one that asks a release server, and checks that it is a function. An object ref
 * has the `releaseId` of its bundle, so the callback can get the locations of every object of a bundle in one request,
 * and keep them.
 */
export function defineLocator<Ref = FileRef>(locate: (ref: Ref) => FileLocation | Promise<FileLocation>): Locator<Ref> {
  if (typeof locate !== 'function')
    throw new TypeError('defineLocator needs a function that takes a file ref and returns its location.')

  return locate
}

/** Returns the URL of a document and of its detached signature. */
export async function locateDocument<Ref>(locate: Locator<Ref>, ref: Ref): Promise<{ signature: string, url: string }> {
  const location = checkLocation(await locate(ref))
  const url = typeof location === 'string' ? location : location.url

  return { signature: (typeof location === 'string' ? undefined : location.signatureUrl) ?? `${url}.sig`, url }
}

/** Returns the URL of a file. */
export async function locateFile<Ref>(locate: Locator<Ref>, ref: Ref): Promise<string> {
  const location = checkLocation(await locate(ref))

  return typeof location === 'string' ? location : location.url
}

/**
 * Rejects a location with a field that it does not have, for example `signature` for `signatureUrl`. TypeScript does
 * not check extra fields of an object that a callback returns, and an ignored field would fetch the wrong signature.
 */
function checkLocation(location: FileLocation): FileLocation {
  if (typeof location === 'string')
    return location
  if (typeof location?.url !== 'string')
    throw new TypeError('A locator returned a location without a url.')

  const unknown = Object.keys(location).find(key => key !== 'url' && key !== 'signatureUrl')
  if (unknown !== undefined)
    throw new TypeError(`A locator returned a location with the field ${unknown}. A location has only url and signatureUrl.`)

  return location
}
