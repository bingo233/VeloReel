import type { DesktopApi } from './types'

declare global {
  interface Window {
    api: DesktopApi
  }
}

export {}
