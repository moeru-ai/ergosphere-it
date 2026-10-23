import type { UpdateResult, UpdateStatus } from '@ergosphere-it/driver-electron/core'

import { contextBridge, ipcRenderer } from 'electron'

/** What the page reports after it mounted. The e2e test reads it from the event log. */
export interface MountedPage {
  label: string
  mainTag: string
}

const api = {
  apply: (): Promise<UpdateResult> => ipcRenderer.invoke('example:apply'),
  mounted: (page: MountedPage): void => ipcRenderer.send('example:mounted', page),
  onStatus: (listener: (status: UpdateStatus) => void): void => {
    ipcRenderer.on('example:status', (_event, status: UpdateStatus) => listener(status))
  },
}

export type ExampleApi = typeof api

contextBridge.exposeInMainWorld('example', api)
