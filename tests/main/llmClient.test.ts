import { describe, expect, it, vi } from 'vitest'
import { requestLlmJsonText, type LlmConnection } from '../../src/main/llmClient'

const connection: LlmConnection = {
  apiKey: 'test-token',
  baseUrl: 'https://provider.example/v1',
  model: 'gpt-5.5',
  apiType: 'chat_completions',
  httpHeaders: { 'x-openai-actor-authorization': 'local-image-extension' },
  storeResponses: false
}
const prompt = { instructions: 'Return a JSON object.', input: 'Analyze this example page.' }

function transport(responseBody: unknown, status = 200) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    })
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'test-request' }
    })
  })
  return { requests, fetcher }
}

function responseOutput(content: unknown[], status = 'completed') {
  return {
    id: 'resp_test',
    object: 'response',
    status,
    output: [
      { id: 'reasoning_test', type: 'reasoning', summary: [] },
      { id: 'message_test', type: 'message', role: 'assistant', status: 'completed', content }
    ]
  }
}

describe('model API protocol compatibility', () => {
  it('sends Chat Completions JSON requests with the configured model, bearer token and custom headers', async () => {
    const mock = transport({ choices: [{ finish_reason: 'stop', message: { content: '{"siteId":"demo"}' } }] })

    await expect(requestLlmJsonText(connection, prompt, mock.fetcher)).resolves.toBe('{"siteId":"demo"}')

    const request = mock.requests[0]!
    expect(request.url).toBe('https://provider.example/v1/chat/completions')
    expect(request.headers.get('authorization')).toBe('Bearer test-token')
    expect(request.headers.get('x-openai-actor-authorization')).toBe('local-image-extension')
    expect(request.body).toEqual({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: prompt.instructions },
        { role: 'user', content: prompt.input }
      ],
      response_format: { type: 'json_object' },
      store: false,
      stream: false
    })
  })

  it('sends Responses requests and reads assistant text even when reasoning appears first', async () => {
    const mock = transport(responseOutput([
      { type: 'output_text', text: '{"siteId":', annotations: [] },
      { type: 'output_text', text: '"demo"}', annotations: [] }
    ]))

    await expect(requestLlmJsonText({ ...connection, apiType: 'responses' }, prompt, mock.fetcher))
      .resolves.toBe('{"siteId":"demo"}')

    const request = mock.requests[0]!
    expect(request.url).toBe('https://provider.example/v1/responses')
    expect(request.headers.get('authorization')).toBe('Bearer test-token')
    expect(request.headers.get('x-openai-actor-authorization')).toBe('local-image-extension')
    expect(request.body).toEqual({
      model: 'gpt-5.5',
      instructions: prompt.instructions,
      input: prompt.input,
      text: { format: { type: 'json_object' } },
      store: false,
      stream: false
    })
  })

  it.each(['chat_completions', 'responses'] as const)('honors response storage preferences for %s', async (apiType) => {
    const mock = transport(apiType === 'responses'
      ? responseOutput([{ type: 'output_text', text: '{}', annotations: [] }])
      : { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })

    await requestLlmJsonText({ ...connection, apiType, storeResponses: true }, prompt, mock.fetcher)

    expect(mock.requests[0]!.body.store).toBe(true)
  })

  it.each(['chat_completions', 'responses'] as const)('preserves 429 errors without retrying or switching protocols for %s', async (apiType) => {
    const mock = transport({ error: { message: 'All available accounts are currently rate-limited. Please retry later.' } }, 429)

    await expect(requestLlmJsonText({ ...connection, apiType }, prompt, mock.fetcher))
      .rejects.toThrow('All available accounts are currently rate-limited')
    expect(mock.fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects incomplete Responses output instead of treating partial JSON as a valid rule', async () => {
    const mock = transport({
      ...responseOutput([{ type: 'output_text', text: '{"siteId":', annotations: [] }], 'incomplete'),
      incomplete_details: { reason: 'max_output_tokens' }
    })

    await expect(requestLlmJsonText({ ...connection, apiType: 'responses' }, prompt, mock.fetcher))
      .rejects.toThrow('max_output_tokens')
  })

  it('reports Responses refusal text instead of a generic JSON parse error', async () => {
    const mock = transport(responseOutput([{ type: 'refusal', refusal: 'Cannot generate this rule.' }]))

    await expect(requestLlmJsonText({ ...connection, apiType: 'responses' }, prompt, mock.fetcher))
      .rejects.toThrow('Cannot generate this rule.')
  })

  it('reports provider errors returned in a Responses body', async () => {
    const mock = transport({ status: 'failed', output: [], error: { code: 'server_error', message: 'Provider unavailable' } })

    await expect(requestLlmJsonText({ ...connection, apiType: 'responses' }, prompt, mock.fetcher))
      .rejects.toThrow('server_error: Provider unavailable')
  })

  it('reports Chat Completions output truncation clearly', async () => {
    const mock = transport({ choices: [{ finish_reason: 'length', message: { content: '{"siteId":' } }] })

    await expect(requestLlmJsonText(connection, prompt, mock.fetcher)).rejects.toThrow('被截断')
  })

  it.each(['chat_completions', 'responses'] as const)('reports empty model output for %s', async (apiType) => {
    const mock = transport(apiType === 'responses'
      ? { status: 'completed', output: [] }
      : { choices: [{ finish_reason: 'stop', message: { content: '' } }] })

    await expect(requestLlmJsonText({ ...connection, apiType }, prompt, mock.fetcher))
      .rejects.toThrow('模型没有返回规则正文')
  })
})
