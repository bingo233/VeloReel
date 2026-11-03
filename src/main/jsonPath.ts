/**
 * JSONPath 子集求值器：支持 $.a.b[0].c、$.a[*].b、$["a b"].c。
 * 故意不支持表达式、过滤器、递归下降——API 声明式规则只需要取值，不需要图灵能力。
 */

type Segment = { key: string } | { index: number } | { wildcard: true }

export function parseJsonPath(path: string): Segment[] {
  const trimmed = path.trim()
  if (!trimmed.startsWith('$')) {
    throw new Error(`JSONPath 必须以 $ 开头：${path}`)
  }
  const segments: Segment[] = []
  let rest = trimmed.slice(1)
  while (rest.length) {
    const dotKey = /^\.([A-Za-z0-9_$\-\u4e00-\u9fa5]+)/.exec(rest)
    if (dotKey) {
      segments.push({ key: dotKey[1]! })
      rest = rest.slice(dotKey[0].length)
      continue
    }
    const bracket = /^\[\s*(?:(\d+)|\*|"([^"]+)"|'([^']+)')\s*\]/.exec(rest)
    if (bracket) {
      if (bracket[1] !== undefined) segments.push({ index: Number(bracket[1]) })
      else if (bracket[2] !== undefined) segments.push({ key: bracket[2] })
      else if (bracket[3] !== undefined) segments.push({ key: bracket[3] })
      else segments.push({ wildcard: true })
      rest = rest.slice(bracket[0].length)
      continue
    }
    if (rest === '.*') {
      segments.push({ wildcard: true })
      rest = ''
      continue
    }
    throw new Error(`无法解析的 JSONPath 片段：${rest}（完整路径 ${path}）`)
  }
  return segments
}

function walk(value: unknown, segments: Segment[], output: unknown[]): void {
  if (!segments.length) {
    if (value !== undefined && value !== null) output.push(value)
    return
  }
  const [head, ...tail] = segments
  if (head === undefined || value === null || value === undefined) return
  if ('wildcard' in head) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, tail, output)
    } else if (typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item, tail, output)
    }
    return
  }
  if ('index' in head) {
    if (Array.isArray(value)) walk(value[head.index], tail, output)
    return
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    walk((value as Record<string, unknown>)[head.key], tail, output)
  }
}

/** 返回路径命中的所有值；路径不存在时为空数组。路径非法时抛错。 */
export function queryJson(data: unknown, path: string): unknown[] {
  const segments = parseJsonPath(path)
  const output: unknown[] = []
  walk(data, segments, output)
  return output
}

/** 取第一个命中值并转为字符串；对象/数组转 JSON 字符串。 */
export function queryString(data: unknown, path: string): string {
  const first = queryJson(data, path)[0]
  if (first === undefined || first === null) return ''
  if (typeof first === 'object') return JSON.stringify(first)
  return String(first)
}
