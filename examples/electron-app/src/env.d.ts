/// <reference types="vite/client" />

import type { UpdatesBridge } from './preload'

declare global {
  interface Window {
    updates: UpdatesBridge
  }
}
