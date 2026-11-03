import OpenAI from 'openai'
import type { LlmConnectionTestResult } from '../shared/types'
import { AppError, errorMessage } from './errors'
import { requestLlmJsonText } from './llmClient'
import type { AppStorage } from './storage'
import { assertSafeRemoteUrl, parseRemoteUrl } from './urlSafety'
import { assertLlmApiType, assertLlmHttpHeaders, requireRecord, requireString } from './validation'

const TEST_TIMEOUT_MS = 45_000

function failureSummary(error: unknown, details: string): string {
  if (error instanceof OpenAI.APIError && error.status) {
    switch (error.status) {
      case 429:
        return /all available accounts.*rate.limit/i.test(details)
          ? '服务商返回 429：当前所有可用账号均被限流。请稍后重试，或联系服务商确认账号池状态。'
          : /quota|insufficient|balance|credit/i.test(details)
            ? '服务商返回 429：可能是额度或余额限制，请检查服务商账户用量与配额。'
            : '服务商返回 429：请求受到限流。请稍后重试，并检查服务商的请求频率和配额限制。'
      case 401:
        return '鉴权失败（401）：请检查 API Key 和服务商要求的自定义请求头。'
      case 403:
        return '访问被拒绝（403）：请检查账号权限、模型访问权限及服务商限制。'
      case 404:
        return '接口或模型不存在（404）：请核对基础地址、接口类型和模型名称。'
      case 400:
      case 422:
        return `请求不被接受（${error.status}）：请核对接口类型、模型以及服务商支持的 JSON 输出等参数。`
      default:
        return error.status >= 500
          ? `模型服务暂时异常（${error.status}），请稍后重试或联系服务商。`
          : `模型请求失败（HTTP ${error.status}），请查看下方完整错误。`
    }
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError ||
    (error instanceof AppError && error.code === 'LLM_TEST_TIMEOUT')) {
    return '连接测试超时（45 秒）：请检查网络、代理或模型服务状态。'
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return '无法连接模型服务：请检查网络、代理、证书和 API Base URL。'
  }
  if (error instanceof AppError) {
    if (error.code === 'LLM_TEST_INVALID_JSON') return '接口已返回内容，但模型没有返回有效 JSON，请查看原始回复。'
    if (error.code === 'LLM_TEST_UNEXPECTED_REPLY') return '接口已返回内容，但模型未按要求回复，请查看原始回复。'
    if (error.code === 'LLM_EMPTY_RESPONSE') return '接口已返回响应，但没有可用的模型文本。'
    return error.message
  }
  return '连接测试失败，请查看下方完整错误。'
}

function diagnosticDetails(error: unknown): string {
  const lines = [errorMessage(error)]
  if (error instanceof OpenAI.APIError && error.error) {
    lines.push(JSON.stringify(error.error, null, 2))
  }
  let cause: unknown = error
  const seen = new Set<unknown>()
  // Include network causes such as ENOTFOUND or certificate errors, without a stack dump.
  for (let depth = 0; depth < 5 && cause instanceof Error && !seen.has(cause); depth += 1) {
    seen.add(cause)
    if (depth > 0) {
      const code = 'code' in cause ? String(cause.code) : ''
      lines.push(`${code ? `${code}: ` : ''}${cause.message}`)
    }
    cause = cause.cause
  }
  return lines.join('\n\n')
}

/** Uses the same JSON-generation path as rules, without persisting any draft settings. */
export async function testLlmConnection(
  inputValue: unknown,
  storage: Pick<AppStorage, 'getApiKey'>,
  fetcher?: typeof fetch
): Promise<LlmConnectionTestResult> {
  const started = performance.now()
  const context: Partial<LlmConnectionTestResult> = {}
  const secrets = new Set<string>()
  const redact = (value: string): string => {
    let result = value
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      const variants = new Set([secret, JSON.stringify(secret).slice(1, -1)])
      try { variants.add(encodeURIComponent(secret)) } catch { /* Invalid Unicode still needs redaction. */ }
      for (const variant of variants) {
        result = result.split(variant).join('[已隐藏]')
      }
    }
    return result
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = requireRecord(inputValue, '连接测试参数')
    if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) secrets.add(raw.apiKey.trim())
    const keyDraft = raw.apiKey === undefined ? '' : requireString(raw.apiKey, 'API Key', 10_000, true)
    const apiKey = keyDraft || storage.getApiKey()
    if (!apiKey) throw new AppError('API_KEY_REQUIRED', '请填写 API Key，或先保存一个模型密钥。')
    secrets.add(apiKey)
    const httpHeaders = assertLlmHttpHeaders(raw.httpHeaders)
    for (const [name, value] of Object.entries(httpHeaders)) {
      if (value && (value.length >= 4 || /auth|key|token|secret|credential/i.test(name))) secrets.add(value)
    }
    const apiType = assertLlmApiType(raw.apiType)
    const model = requireString(raw.model, '模型名称', 200)
    const baseUrl = parseRemoteUrl(requireString(raw.apiBaseUrl, 'API Base URL'))
    if (baseUrl.search || baseUrl.hash) {
      throw new AppError('INVALID_ARGUMENT', 'API Base URL 不能包含查询参数或片段，请填写接口基础地址。')
    }
    if (typeof raw.storeResponses !== 'boolean') {
      throw new AppError('INVALID_ARGUMENT', '保存模型响应选项必须是布尔值')
    }
    const normalizedBase = baseUrl.toString().replace(/\/+$/, '')
    context.apiType = apiType
    context.model = redact(model)
    context.endpoint = redact(`${normalizedBase}/${apiType === 'responses' ? 'responses' : 'chat/completions'}`)
    const controller = new AbortController()
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AppError('LLM_TEST_TIMEOUT', '连接测试超过 45 秒，已停止请求。'))
        controller.abort()
      }, TEST_TIMEOUT_MS)
    })
    const probe = async (): Promise<string> => {
      await assertSafeRemoteUrl(baseUrl)
      controller.signal.throwIfAborted()
      return requestLlmJsonText({
        apiKey, baseUrl: normalizedBase, model, apiType, httpHeaders,
        storeResponses: raw.storeResponses as boolean
      }, {
        instructions: 'Return only the JSON object {"ok":true}.',
        input: 'This is a connection test. Reply with the JSON object {"ok":true}.'
      }, fetcher, { timeoutMs: TEST_TIMEOUT_MS, signal: controller.signal })
    }
    const text = await Promise.race([probe(), timeout])
    let reply: unknown
    try {
      reply = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    } catch {
      throw new AppError('LLM_TEST_INVALID_JSON', `接口已返回内容，但未返回有效 JSON。模型原始回复：\n${text}`)
    }
    if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) {
      throw new AppError('LLM_TEST_UNEXPECTED_REPLY', `接口已返回内容，但未通过测试回复校验。模型原始回复：\n${text}`)
    }
    return {
      ...context, success: true, elapsedMs: Math.round(performance.now() - started),
      summary: '连接成功，模型已返回有效 JSON。', details: redact(text)
    }
  } catch (error) {
    const details = redact(diagnosticDetails(error))
    const apiError = error instanceof OpenAI.APIError ? error : undefined
    return {
      ...context, success: false, elapsedMs: Math.round(performance.now() - started),
      summary: redact(failureSummary(error, details)), details,
      ...(apiError?.status ? { httpStatus: apiError.status } : {}),
      ...(apiError?.requestID ? { requestId: redact(apiError.requestID) } : {}),
      ...(apiError?.headers?.get('retry-after') ? { retryAfter: redact(apiError.headers.get('retry-after')!) } : {})
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
