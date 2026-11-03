import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStorage } from '../../src/main/storage'
import type { StreamCacheEntry } from '../../src/main/streamResolver'

const fixture = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  available: vi.fn(() => true),
  encrypt: vi.fn((plain: string) => Buffer.from(Buffer.from(plain).toString('base64'))),
  decrypt: vi.fn((cipher: Buffer) => Buffer.from(cipher.toString(), 'base64').toString())
}))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: fixture.available, encryptString: fixture.encrypt, decryptString: fixture.decrypt
} }))
vi.mock('electron-store', () => ({ default: class {
  get(key: string, fallback: unknown) { return fixture.values.get(key) ?? fallback }
  set(key: string, value: unknown) { fixture.values.set(key, value) }
} }))

const entries: StreamCacheEntry[] = [{
  key: 'a'.repeat(64), siteId: 'site', url: 'https://cdn.example/video.m3u8?token=secret-token',
  headers: { cookie: 'secret-cookie', authorization: 'Bearer secret-auth' },
  mediaType: 'hls', extractedBy: 'sniffer', createdAt: 1, expiresAt: 1000
}]

beforeEach(() => {
  fixture.values.clear()
  fixture.available.mockReturnValue(true)
  vi.clearAllMocks()
})

describe('persistent playback cache protection', () => {
  it('encrypts addresses and request credentials together before storing them', () => {
    const storage = new AppStorage()
    storage.saveStreamCache(entries)
    expect(fixture.encrypt).toHaveBeenCalledWith(JSON.stringify(entries))
    const persisted = fixture.values.get('streamCacheCipher')
    expect(typeof persisted).toBe('string')
    expect(persisted).not.toContain('secret-')
    expect(new AppStorage().getStreamCache()).toEqual(entries)
    expect(fixture.values.size).toBe(1)
  })

  it('does not fall back to plaintext storage when system encryption is unavailable', () => {
    fixture.available.mockReturnValue(false)
    const storage = new AppStorage()
    storage.saveStreamCache(entries)
    expect(fixture.encrypt).not.toHaveBeenCalled()
    expect(fixture.values.size).toBe(0)
    expect(storage.getStreamCache()).toEqual([])
  })

  it('ignores corrupted cache data instead of preventing application startup', () => {
    fixture.values.set('streamCacheCipher', 'corrupted-data')
    expect(new AppStorage().getStreamCache()).toEqual([])
  })
})
