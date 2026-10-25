import type { FileLocation, FileRef, Locator } from '@ergosphere-it/client'

import { createTreeLocator as createProtocolTreeLocator, defineLocator as defineProtocolLocator } from '@ergosphere-it/client'

export type { FileLocation, Locator } from '@ergosphere-it/client'

/**
 * The files that the Electron launcher fetches: the files of the protocol, and the electron-updater feed of a platform.
 * `installer-feed` is a base URL, where electron-updater reads `latest*.yml`. The specification does not define it.
 */
export type LauncherFileRef = FileRef | { kind: 'installer-feed', platform: string, releaseId: number }

/** Creates the locator of the default layout under `feedUrl`, with the electron-updater feeds. The launcher uses it by default. */
export function createTreeLocator(feedUrl: string): Locator<LauncherFileRef> {
  const base = feedUrl.replace(/\/+$/, '')
  const tree = createProtocolTreeLocator(base)

  return ref => ref.kind === 'installer-feed' ? `${base}/installers/${ref.releaseId}/feeds/${ref.platform}` : tree(ref)
}

/**
 * Types a locator callback for `locate` of `startLauncher`, and checks that it is a function. It gets every ref of the
 * protocol, and `installer-feed`.
 */
export function defineLocator(locate: (ref: LauncherFileRef) => FileLocation | Promise<FileLocation>): Locator<LauncherFileRef> {
  return defineProtocolLocator(locate)
}
