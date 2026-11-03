import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))
vi.mock('electron', () => ({ safeStorage: {} }))
vi.mock('electron-store', () => ({
  default: class {
    get(key: string, fallback: unknown) { return state.data[key] ?? fallback }
    set(key: string, value: unknown) { state.data[key] = value }
  }
}))

import { AppStorage } from '../../src/main/storage'
import { assertLlmHttpHeaders } from '../../src/main/validation'

beforeEach(() => {
  state.data = {
    settings: { llmApiBaseUrl: 'https://provider.example/v1', llmModel: 'gpt-5.5', autoPlayNext: false },
    llmApiKeyCipher: 'existing-encrypted-value'
  }
})

describe('model settings compatibility', () => {
  it('adds Chat Completions defaults to existing settings without changing the URL, model or encrypted key', () => {
    const storage = new AppStorage()

    expect(storage.getSettings()).toMatchObject({
      llmApiBaseUrl: 'https://provider.example/v1',
      llmModel: 'gpt-5.5',
      llmApiType: 'chat_completions',
      llmHttpHeaders: {},
      llmStoreResponses: false,
      autoPlayNext: false
    })
    expect(state.data.llmApiKeyCipher).toBe('existing-encrypted-value')
  })

  it('persists Responses preferences, headers and storage policy across instances', () => {
    const storage = new AppStorage()
    storage.saveSettings({
      llmApiType: 'responses',
      llmHttpHeaders: { 'X-OpenAI-Actor-Authorization': 'local-image-extension' },
      llmStoreResponses: true
    })

    expect(new AppStorage().getSettings()).toMatchObject({
      llmApiType: 'responses',
      llmHttpHeaders: { 'x-openai-actor-authorization': 'local-image-extension' },
      llmStoreResponses: true,
      llmModel: 'gpt-5.5',
      autoPlayNext: false
    })
  })

  it('rejects unsupported protocols before changing settings', () => {
    const storage = new AppStorage()

    expect(() => storage.saveSettings({ llmApiType: 'invalid' } as never)).toThrow('接口类型')
    expect(storage.getSettings().llmApiType).toBe('chat_completions')
  })
})

describe('custom model HTTP headers', () => {
  it('rejects CRLF values before they can become an HTTP request', () => {
    expect(() => assertLlmHttpHeaders({ 'x-provider': 'value\r\nx-injected: true' })).toThrow('无效字符或换行')
  })

  it.each([[], 'header=value', { 'x-provider': 123 }])('rejects malformed header data: %j', (headers) => {
    expect(() => assertLlmHttpHeaders(headers)).toThrow()
  })

  it('keeps Bearer authentication managed by the API Key field', () => {
    expect(() => assertLlmHttpHeaders({ Authorization: 'Bearer test' })).toThrow('API Key')
  })
})
