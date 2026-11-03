import type { FavoriteInput } from './types'

export function favoriteKey(item: Pick<FavoriteInput, 'siteId' | 'detailUrl'>): string {
  let address = item.detailUrl
  try {
    const url = new URL(address)
    url.hash = ''
    address = url.href
  } catch { /* Invalid input is reported by the main process when saving. */ }
  return `${item.siteId}\0${address}`
}
