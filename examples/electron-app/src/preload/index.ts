import type { BundleInfo, UpdaterStatus } from '@ergosphere-it/electron/types'

import { contextBridge, ipcRenderer } from 'electron'

/** What the page can do with updates. The main process answers on the channels of `src/main/index.ts`. */
const updates = {
  apply: (): Promise<void> => ipcRenderer.invoke('updates:apply'),
  check: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updates:check'),
  delayHealthCheck: (seconds: number): void => ipcRenderer.send('updates:delay-health-check', seconds),
  dismissRollback: (): Promise<void> => ipcRenderer.invoke('updates:dismiss-rollback'),
  get: (): Promise<{ bundle: BundleInfo, status: UpdaterStatus }> => ipcRenderer.invoke('updates:get'),
  markHealthy: (): void => ipcRenderer.send('updates:healthy'),
  onStatus: (listener: (status: UpdaterStatus) => void): void => {
    ipcRenderer.on('updates:status', (_event, status: UpdaterStatus) => listener(status))
  },
}

export type UpdatesBridge = typeof updates

contextBridge.exposeInMainWorld('updates', updates)
