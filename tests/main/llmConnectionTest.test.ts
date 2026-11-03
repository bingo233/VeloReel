import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { testLlmConnection } from '../../src/main/llmConnectionTest'
import type { LlmApiType, LlmConnectionTestInput } from '../../src/shared/types'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}))

const draft: LlmConnectionTestInput = {
  apiBaseUrl: 'https://draft.provider.example/v1/',
  model: 'gpt-5.5',
  apiType: 'responses',
  apiKey: 'draft-secret-token',
  httpHeaders: { 'x-openai-actor-authorization': 'local-image-extension' },
  storeResponses: false
}

function modelReply(apiType: LlmApiType, text = '{"ok":true}') {
  return apiType === 'responses'
    ? {
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text }] }
        ]
      }
    : { choices: [{ finish_reason: 'stop', message: { content: text } }] }
}

function transport(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({
      url: String(url), headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    })
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json', ...headers }
    })
  })
  return { requests, fetcher }
}

function savedStorage() {
  return {
    getApiKey: vi.fn(() => 'saved-secret-token'),
    saveApiKey: vi.fn(), saveSettings: vi.fn(), clearApiKey: vi.fn()
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('model connection diagnostics', () => {
  it.each(['chat_completions', 'responses'] as const)('tests actual JSON generation with the unsaved %s configuration', async (apiType) => {
    const mock = transport(modelReply(apiType))
    const storage = savedStorage()
    const result = await testLlmConnection({ ...draft, apiType }, storage, mock.fetcher)

    expect(result).toMatchObject({
      success: true, model: 'gpt-5.5', apiType,
      endpoint: `https://draft.provider.example/v1/${apiType === 'responses' ? 'responses' : 'chat/completions'}`,
      details: '{"ok":true}'
    })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    const request = mock.requests[0]!
    expect(request.url).toBe(result.endpoint)
    expect(request.headers.get('authorization')).toBe('Bearer draft-secret-token')
    expect(request.headers.get('x-openai-actor-authorization')).toBe('local-image-extension')
    expect(request.body).toMatchObject({ model: 'gpt-5.5', store: false, stream: false })
    expect(apiType === 'responses' ? request.body.text : request.body.response_format).toEqual(
      apiType === 'responses' ? { format: { type: 'json_object' } } : { type: 'json_object' }
    )
    expect(storage.getApiKey).not.toHaveBeenCalled()
    expect(storage.saveSettings).not.toHaveBeenCalled()
    expect(storage.saveApiKey).not.toHaveBeenCalled()
    expect(storage.clearApiKey).not.toHaveBeenCalled()
    expect(mock.fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, '', '   '])('uses the saved key when the draft key is %j', async (apiKey) => {
    const mock = transport(modelReply('responses'))
    const storage = savedStorage()
    expect((await testLlmConnection({ ...draft, apiKey }, storage, mock.fetcher)).success).toBe(true)
    expect(mock.requests[0]!.headers.get('authorization')).toBe('Bearer saved-secret-token')
    expect(storage.getApiKey).toHaveBeenCalledOnce()
    expect(storage.saveApiKey).not.toHaveBeenCalled()
  })

  it('honors the current response-storage option', async () => {
    const mock = transport(modelReply('responses'))
    await testLlmConnection({ ...draft, storeResponses: true }, savedStorage(), mock.fetcher)
    expect(mock.requests[0]!.body.store).toBe(true)
  })

  it.each(['chat_completions', 'responses'] as const)('preserves provider 429 diagnostics and does not retry %s requests', async (apiType) => {
    const message = 'All available accounts are currently rate-limited. Please retry later.'
    const mock = transport({ error: { message, code: 'rate_limit_exceeded' } }, 429, {
      'x-request-id': 'req-provider-test', 'retry-after': '60'
    })
    const result = await testLlmConnection({ ...draft, apiType }, savedStorage(), mock.fetcher)
    expect(result).toMatchObject({
      success: false, httpStatus: 429, requestId: 'req-provider-test', retryAfter: '60'
    })
    expect(result.summary).toContain('所有可用账号均被限流')
    expect(result.details).toContain(message)
    expect(result.details).toContain('rate_limit_exceeded')
    expect(mock.fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, '鉴权失败'], [403, '访问被拒绝'], [404, '接口或模型不存在'],
    [400, '请求不被接受'], [422, '请求不被接受'], [503, '模型服务暂时异常']
  ])('explains HTTP %i without hiding the provider error', async (status, explanation) => {
    const mock = transport({ error: { message: 'Provider diagnostic message' } }, Number(status))
    const result = await testLlmConnection(draft, savedStorage(), mock.fetcher)
    expect(result.success).toBe(false)
    expect(result.summary).toContain(explanation)
    expect(result.details).toContain('Provider diagnostic message')
  })

  it('distinguishes quota exhaustion from the provider account-pool error', async () => {
    const mock = transport({ error: { message: 'insufficient_quota' } }, 429)
    const result = await testLlmConnection(draft, savedStorage(), mock.fetcher)
    expect(result.summary).toContain('额度或余额')
    expect(result.summary).not.toContain('所有可用账号')
  })

  it('redacts echoed API keys and custom credentials from all returned diagnostics', async () => {
    const mock = transport({ error: { message: 'rejected draft-secret-token / local-image-extension' } }, 401, {
      'x-request-id': 'draft-secret-token', 'retry-after': 'local-image-extension'
    })
    const result = await testLlmConnection(draft, savedStorage(), mock.fetcher)
    expect(JSON.stringify(result)).not.toContain('draft-secret-token')
    expect(JSON.stringify(result)).not.toContain('local-image-extension')
    expect(result.details).toContain('[已隐藏]')
  })

  it.each(['not JSON', '{"ok":false}', '{}'])('does not report success for an invalid probe reply: %s', async (text) => {
    const mock = transport(modelReply('responses', text))
    const result = await testLlmConnection(draft, savedStorage(), mock.fetcher)
    expect(result.success).toBe(false)
    expect(result.details).toContain(text)
  })

  it('preserves network error causes for debugging', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('certificate has expired', { cause: new Error('CERT_HAS_EXPIRED') })
    })
    const result = await testLlmConnection(draft, savedStorage(), fetcher)
    expect(result.summary).toContain('无法连接模型服务')
    expect(result.details).toContain('certificate has expired')
    expect(result.details).toContain('CERT_HAS_EXPIRED')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([
    { apiType: 'invalid' }, { model: '   ' }, { apiBaseUrl: 'http://127.0.0.1/v1' },
    { apiBaseUrl: 'https://user:password@provider.example/v1' },
    { apiBaseUrl: 'https://provider.example/v1?key=secret' },
    { httpHeaders: { 'x-test': 'value\r\nx-injected: true' } },
    { httpHeaders: { Authorization: 'Bearer another-key' } }
  ])('rejects invalid connection configuration before sending HTTP: %j', async (invalid) => {
    const mock = transport(modelReply('responses'))
    const result = await testLlmConnection({ ...draft, ...invalid }, savedStorage(), mock.fetcher)
    expect(result.success).toBe(false)
    expect(mock.fetcher).not.toHaveBeenCalled()
    expect(result.endpoint).toBeUndefined()
  })

  it('reports missing credentials before sending HTTP', async () => {
    const mock = transport(modelReply('responses'))
    const result = await testLlmConnection({ ...draft, apiKey: '' }, { getApiKey: () => undefined }, mock.fetcher)
    expect(result.summary).toContain('请填写 API Key')
    expect(mock.fetcher).not.toHaveBeenCalled()
  })

  it('blocks a provider hostname resolving to a private address', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never)
    const mock = transport(modelReply('responses'))
    const result = await testLlmConnection(draft, savedStorage(), mock.fetcher)
    expect(result.summary).toContain('域名解析到了本机或内网地址')
    expect(mock.fetcher).not.toHaveBeenCalled()
  })

  it('limits the whole test to 45 seconds and aborts the pending HTTP request', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | null | undefined
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      requestSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const pending = testLlmConnection(draft, savedStorage(), fetcher)
    await vi.advanceTimersByTimeAsync(45_001)
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.summary).toContain('超时')
    expect(requestSignal?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('also times out a stalled response body', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
        }
      })
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    })
    const pending = testLlmConnection(draft, savedStorage(), fetcher)
    await vi.advanceTimersByTimeAsync(45_001)
    expect((await pending).summary).toContain('超时')
  })
})
