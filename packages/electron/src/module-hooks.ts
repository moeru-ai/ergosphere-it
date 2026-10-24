import { mkdirSync, realpathSync } from 'node:fs'
import { isBuiltin, registerHooks } from 'node:module'
import { platform } from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * Resolves bare imports of downloaded bundles from the launcher.
 *
 * A downloaded bundle lives in the user data directory, so Node.js cannot find the `node_modules` of the app from it.
 * Native modules and other dependencies stay next to the launcher, and bundles import them by name.
 */
export function registerBundleModuleHooks(launcherUrl: string, bundlesDir: string): void {
  // NOTICE:
  // Node.js reports the real path of a module as its parent URL, but the data directory can be a symlink.
  // For example, macOS gives /var/folders/..., and the real path is /private/var/folders/...
  // Both prefixes must match, or bare imports of downloaded bundles fail with ERR_MODULE_NOT_FOUND.
  // Found by tests/electron/scripts/e2e.ts on macOS. Keep this while data directories can be symlinks.
  mkdirSync(bundlesDir, { recursive: true })
  // Windows paths are case-insensitive, and URLs of the same file can differ in drive letter case.
  const fold = (url: string) => (platform === 'win32' ? url.toLowerCase() : url)
  const prefixes = [...new Set([bundlesDir, realpathSync.native(bundlesDir)])].map(dir => fold(`${pathToFileURL(dir).href}/`))

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL && prefixes.some(prefix => fold(context.parentURL!).startsWith(prefix)) && isBareSpecifier(specifier))
        return nextResolve(specifier, { ...context, parentURL: launcherUrl })

      return nextResolve(specifier, context)
    },
  })
}

function isBareSpecifier(specifier: string): boolean {
  if (specifier === 'electron' || specifier.startsWith('electron/') || isBuiltin(specifier))
    return false

  return !/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:|\\\\)/i.test(specifier)
}
