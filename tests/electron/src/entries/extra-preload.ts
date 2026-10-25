// A second preload entry. A sandboxed window loads it with activeBundle.preloadOf('extra').

import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('ergosphereExtraPreload', { loaded: true })
