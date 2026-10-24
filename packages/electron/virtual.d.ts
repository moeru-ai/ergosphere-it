// Types of the virtual modules of the ergosphere-it plugins, for a custom launcher.
// Add `"types": ["@ergosphere-it/electron/virtual"]` to the tsconfig of the main process.

declare module 'virtual:ergosphere-it/config' {
  import type { LauncherConfig } from '@ergosphere-it/electron/launcher'

  /** The settings of `ergo.config.ts`, resolved at build time. */
  const config: LauncherConfig
  export default config
}
