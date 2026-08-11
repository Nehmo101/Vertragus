import type { VertragusApi } from './index'

declare global {
  interface Window {
    vertragus: VertragusApi
  }
}

export {}
