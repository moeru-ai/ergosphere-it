import type { PageUpdater, UpdaterStatus } from './status'

import { contextBridge, ipcRenderer } from 'electron'

import { IPC, PAGE_GLOBAL } from './ipc'

export type * from './status'

/**
 * Gives the page its updater as `window.ergosphereIt`, through `contextBridge`.
 *
 * The page can read the status, check, apply the ready update, and mark the bundle healthy. It cannot change the
 * channel or install anything that the launcher did not verify.
 */
export function exposeUpdater(): void {
  const updater: PageUpdater = {
    applyUpdate: () => ipcRenderer.invoke(IPC.apply),
    checkForUpdates: () => ipcRenderer.invoke(IPC.check),
    dismissRollback: () => ipcRenderer.invoke(IPC.dismissRollback),
    getActiveBundle: () => ipcRenderer.invoke(IPC.getActiveBundle),
    getStatus: () => ipcRenderer.invoke(IPC.getStatus),
    markBundleHealthy: () => ipcRenderer.send(IPC.healthy),
    onStatus: (listener) => {
      const handler = (_event: unknown, status: UpdaterStatus) => listener(status)
      ipcRenderer.on(IPC.status, handler)

      return () => ipcRenderer.removeListener(IPC.status, handler)
    },
  }

  contextBridge.exposeInMainWorld(PAGE_GLOBAL, updater)
}
