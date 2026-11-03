import OpenAI from 'openai'
import type { LlmApiType } from '../shared/types'
import { AppError } from './errors'

export interface LlmConnection {
  apiKey: string
  baseUrl: string
  model: string
  apiType: LlmApiType
  httpHeaders: Record<string, string>
  storeResponses: boolean
}

export interface LlmPrompt {
  instructions: string
  input: string
}

interface LlmRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** Both rule generation and auto-healing use the same provider configuration. */
export async function requestLlmJsonText(
  connection: LlmConnection,
  prompt: LlmPrompt,
  fetcher?: typeof fetch,
  options: LlmRequestOptions = {}
): Promise<string> {
  const client = new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseUrl || undefined,
    defaultHeaders: connection.httpHeaders,
    timeout: options.timeoutMs ?? 120_000,
    maxRetries: 0,
    ...(fetcher ? { fetch: fetcher } : {})
  })

  if (connection.apiType === 'responses') {
    const response = await client.responses.create({
      model: connection.model,
      instructions: prompt.instructions,
      input: prompt.input,
      text: { format: { type: 'json_object' } },
      store: connection.storeResponses,
      stream: false
    }, { signal: options.signal })

    if (response.error) {
      throw new AppError('LLM_RESPONSE_FAILED', `${response.error.code}: ${response.error.message}`)
    }
    if (response.status === 'incomplete') {
      throw new AppError('LLM_INCOMPLETE_RESPONSE',
        `模型输出不完整：${response.incomplete_details?.reason ?? '未提供原因'}，请重试或调整模型配置`)
    }
    if (response.status && response.status !== 'completed') {
      throw new AppError('LLM_RESPONSE_FAILED', `模型请求未完成，状态：${response.status}`)
    }

    // Reasoning/tool items can precede the assistant message in Responses output.
    const messages = (response.output ?? []).filter((item) => item.type === 'message')
    const content = response.output_text || messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('')
    if (content?.trim()) return content

    const refusals = messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'refusal')
      .map((part) => part.refusal)
      .join('\n')
    if (refusals) throw new AppError('LLM_REFUSAL', `模型拒绝生成：${refusals}`)
  } else {
    const completion = await client.chat.completions.create({
      model: connection.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt.instructions },
        { role: 'user', content: prompt.input }
      ],
      store: connection.storeResponses,
      stream: false
    }, { signal: options.signal })
    const choice = completion.choices[0]
    if (choice?.finish_reason === 'length') {
      throw new AppError('LLM_INCOMPLETE_RESPONSE', '模型输出因长度限制被截断，请重试或调整模型配置')
    }
    if (choice?.message.refusal) {
      throw new AppError('LLM_REFUSAL', `模型拒绝生成：${choice.message.refusal}`)
    }
    if (choice?.message.content?.trim()) return choice.message.content
  }

  throw new AppError('LLM_EMPTY_RESPONSE', '模型没有返回规则正文')
}
