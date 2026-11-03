import { describe, expect, it } from 'vitest'
import { parseJsChallenge } from '../../src/main/jsChallenge'

const CHALLENGE_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>请稍候</title>
<p>正在验证浏览器，请稍候……</p>
<script>document.cookie="idc_search_browser=50b0ebf7c6c261ff35feb8c917aa03d1; Max-Age=1800; Path=/; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");
if(document.cookie.indexOf("idc_search_browser=50b0ebf7c6c261ff35feb8c917aa03d1")!==-1){
var u=new URL(location.href);u.searchParams.set("_idc_pass",Date.now().toString(36)+Math.random().toString(36).slice(2,8));location.replace(u.href)}
</script></html>`

describe('parseJsChallenge', () => {
  it('识别 JS Cookie 验证页并提取 Cookie 与重载参数', () => {
    expect(parseJsChallenge(CHALLENGE_HTML)).toEqual({
      cookiePair: 'idc_search_browser=50b0ebf7c6c261ff35feb8c917aa03d1',
      maxAgeMs: 1_800_000,
      passParam: '_idc_pass'
    })
  })

  it('普通页面不误判', () => {
    expect(parseJsChallenge('<html><body><a href="/detail/1.html">影片</a></body></html>')).toBeNull()
    expect(parseJsChallenge('<html><script>document.title="x"</script></html>')).toBeNull()
  })

  it('没有重载参数时 passParam 为 null，Max-Age 缺省为 30 分钟', () => {
    const html = `<script>document.cookie="ab=cd; Path=/";location.replace(location.href)</script>`
    expect(parseJsChallenge(html)).toEqual({
      cookiePair: 'ab=cd',
      maxAgeMs: 30 * 60_000,
      passParam: null
    })
  })

  it('缺少 Cookie 赋值或重载时不识别', () => {
    expect(parseJsChallenge('<script>location.replace("/")</script>')).toBeNull()
    expect(parseJsChallenge('<script>document.cookie="a=b"</script>')).toBeNull()
  })
})
