import { readResponseBuffer, safeFetch } from './urlSafety'
import type { SafeFetchOptions } from './urlSafety'

/**
 * 处理模板站常见的“JS Cookie 质询”反爬：
 * 首次请求返回极小的验证页，JS 写入 Cookie 后带随机参数重载才能拿到真实页面。
 * 纯 HTTP 抓取无法执行 JS，这里识别该模式、提取 Cookie 并自动重试一次，
 * Cookie 按源站缓存，有效期内不再重复验证。
 */

const CHALLENGE_LIMIT = 64 * 1024
const DEFAULT_MAX_AGE_MS = 30 * 60_000

interface ChallengeCookie {
  value: string
  expiresAt: number
}

export interface JsChallenge {
  cookiePair: string
  maxAgeMs: number
  /** 验证页重载时附加的查询参数名，例如 _idc_pass。 */
  passParam: string | null
}

export interface ChallengedPage {
  status: number
  ok: boolean
  html: string
  finalUrl: string
}

const cookieCache = new Map<string, ChallengeCookie>()

/** 判断 HTML 是否为 JS Cookie 验证页，并提取 Cookie 与重载参数。 */
export function parseJsChallenge(html: string): JsChallenge | null {
  if (!/location\.replace\s*\(/.test(html)) {
    return null
  }
  const cookieMatch = /document\.cookie\s*=\s*"([^"]+)"/i.exec(html)
  const cookieValue = cookieMatch?.[1]
  if (!cookieValue) {
    return null
  }
  const segments = cookieValue.split(';').map((segment) => segment.trim())
  const pair = segments[0] ?? ''
  const separator = pair.indexOf('=')
  if (separator <= 0) {
    return null
  }
  const maxAge = /max-age=(\d+)/i.exec(cookieValue)
  const passParam = /searchParams\.set\("([^"]+)"/.exec(html)
  return {
    cookiePair: pair,
    maxAgeMs: maxAge ? Number(maxAge[1]) * 1000 : DEFAULT_MAX_AGE_MS,
    passParam: passParam?.[1] ?? null
  }
}

function cachedCookie(origin: string): string | null {
  const entry = cookieCache.get(origin)
  if (!entry) {
    return null
  }
  if (Date.now() >= entry.expiresAt) {
    cookieCache.delete(origin)
    return null
  }
  return entry.value
}

function rememberCookie(origin: string, challenge: JsChallenge): void {
  cookieCache.set(origin, {
    value: challenge.cookiePair,
    expiresAt: Date.now() + Math.min(challenge.maxAgeMs, 24 * 60 * 60_000)
  })
}

function withCookie(headers: Headers, cookie: string | null): Headers {
  const next = new Headers(headers)
  if (cookie && !next.has('cookie')) {
    next.set('cookie', cookie)
  }
  return next
}

async function readPage(response: Response, requestedUrl: string, maxBytes: number): Promise<ChallengedPage> {
  if (!response.ok) {
    await response.body?.cancel()
    return { status: response.status, ok: false, html: '', finalUrl: response.url || requestedUrl }
  }
  const buffer = await readResponseBuffer(response, maxBytes)
  return {
    status: response.status,
    ok: true,
    html: buffer.toString('utf8'),
    finalUrl: response.url || requestedUrl
  }
}

/**
 * 与 safeFetch 相同的校验与超时语义，额外自动通过 JS Cookie 质询。
 * 仅对 GET 请求启用；验证页最多触发一次带 Cookie 的重试。
 */
export async function fetchHtmlWithJsChallenge(
  input: string | URL,
  init: RequestInit,
  options: SafeFetchOptions,
  maxBytes: number
): Promise<ChallengedPage> {
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const response = await safeFetch(input, init, options)
    return readPage(response, input.toString(), maxBytes)
  }

  const url = new URL(input.toString())
  const origin = url.origin
  const headers = withCookie(new Headers(init.headers), cachedCookie(origin))
  const first = await safeFetch(url, { ...init, headers }, options)
  const type = first.headers.get('content-type') ?? ''
  const maybeHtml = /text\/html|application\/xhtml/i.test(type) || type === ''

  if (!first.ok || !maybeHtml) {
    return readPage(first, url.toString(), maxBytes)
  }

  // 验证页只有几百字节，完整读入后仅对小页面做质询识别，避免误伤大页面。
  const body = await readResponseBuffer(first, maxBytes)
  const html = body.toString('utf8')
  const challenge = body.byteLength <= CHALLENGE_LIMIT ? parseJsChallenge(html) : null
  if (!challenge) {
    return { status: first.status, ok: true, html, finalUrl: first.url || url.toString() }
  }

  rememberCookie(origin, challenge)
  const retry = new URL(first.url || url.toString())
  if (challenge.passParam && !retry.searchParams.has(challenge.passParam)) {
    retry.searchParams.set(challenge.passParam, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
  }
  const second = await safeFetch(
    retry,
    { ...init, headers: withCookie(new Headers(init.headers), challenge.cookiePair) },
    options
  )
  return readPage(second, retry.toString(), maxBytes)
}
