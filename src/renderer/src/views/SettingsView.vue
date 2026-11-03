<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import UiIcon from '../components/UiIcon.vue'
import type { LlmConnectionTestResult } from '../../../shared/types'
import { DEFAULT_SETTINGS, type AppSettings, type ToastMessage } from '../types'
import { errorMessage } from '../utils'

const emit = defineEmits<{
  notify: [tone: ToastMessage['tone'], title: string, message?: string]
}>()

const form = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
const newApiKey = ref('')
const headersJson = ref('{}')
const headersError = ref('')
const apiKeyConfigured = ref(false)
const loading = ref(true)
const saving = ref(false)
const keyVisible = ref(false)
const testing = ref(false)
const testResult = ref<LlmConnectionTestResult | null>(null)
const configurationVersion = ref(0)
const testedConfigurationVersion = ref(-1)
const copyFeedback = ref('')
watch(() => [
  form.llmApiBaseUrl, form.llmModel, form.llmApiType, headersJson.value,
  form.llmStoreResponses, newApiKey.value, apiKeyConfigured.value
], () => {
  configurationVersion.value += 1
  copyFeedback.value = ''
}, { flush: 'sync' })
const testResultStale = computed(() => Boolean(testResult.value) && testedConfigurationVersion.value !== configurationVersion.value)

function readHeaders(): Record<string, string> | null {
  headersError.value = ''
  try {
    const headers: unknown = JSON.parse(headersJson.value.trim() || '{}')
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) ||
      Object.values(headers).some((value) => typeof value !== 'string')) {
      throw new Error('请填写 JSON 对象，所有请求头的值都必须是字符串')
    }
    return headers as Record<string, string>
  } catch (error) {
    headersError.value = `自定义请求头格式错误：${errorMessage(error)}`
    return null
  }
}

async function testConnection(): Promise<void> {
  if (testing.value || saving.value) return
  const headers = readHeaders()
  if (!headers) return
  testedConfigurationVersion.value = configurationVersion.value
  testResult.value = null
  copyFeedback.value = ''
  testing.value = true
  const started = performance.now()
  try {
    testResult.value = await window.api.settings.testConnection({
      apiBaseUrl: form.llmApiBaseUrl.trim(),
      model: form.llmModel.trim(),
      apiType: form.llmApiType,
      httpHeaders: headers,
      storeResponses: form.llmStoreResponses,
      ...(newApiKey.value.trim() ? { apiKey: newApiKey.value.trim() } : {})
    })
  } catch (error) {
    testResult.value = {
      success: false, elapsedMs: Math.round(performance.now() - started),
      summary: '无法完成连接测试，请查看完整错误。', details: errorMessage(error)
    }
  } finally {
    testing.value = false
  }
}

async function copyTestResult(): Promise<void> {
  const result = testResult.value
  if (!result) return
  const protocol = result.apiType === 'responses' ? 'Responses' : 'Chat Completions'
  const text = [
    testResultStale.value ? '配置已修改，以下是之前配置的测试结果。' : '',
    result.summary,
    `耗时：${(result.elapsedMs / 1000).toFixed(2)} 秒`,
    result.apiType ? `接口类型：${protocol}` : '',
    result.model ? `模型：${result.model}` : '',
    result.endpoint ? `请求地址：${result.endpoint}` : '',
    result.httpStatus ? `HTTP 状态：${result.httpStatus}` : '',
    result.requestId ? `请求 ID：${result.requestId}` : '',
    result.retryAfter ? `Retry-After：${result.retryAfter}` : '',
    result.details
  ].filter(Boolean).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    copyFeedback.value = '已复制测试详情'
  } catch {
    copyFeedback.value = '复制失败，可选中下方文字手动复制'
  }
}

async function loadSettings(): Promise<void> {
  loading.value = true
  try {
    Object.assign(form, DEFAULT_SETTINGS, await window.api.settings.get())
    headersJson.value = JSON.stringify(form.llmHttpHeaders, null, 2)
    apiKeyConfigured.value = await window.api.settings.hasApiKey()
  } catch (error) {
    emit('notify', 'danger', '设置加载失败', errorMessage(error))
  } finally {
    loading.value = false
  }
}

async function saveSettings(): Promise<void> {
  if (saving.value || testing.value) return
  saving.value = true
  try {
    const headers = readHeaders()
    if (!headers) return
    const payload: Partial<AppSettings> = {
      llmApiBaseUrl: form.llmApiBaseUrl.trim(),
      llmModel: form.llmModel.trim(),
      llmApiType: form.llmApiType,
      llmHttpHeaders: headers,
      llmStoreResponses: form.llmStoreResponses,
      autoPlayNext: form.autoPlayNext,
      skipIntroSeconds: Math.max(0, Number(form.skipIntroSeconds) || 0),
      skipOutroSeconds: Math.max(0, Number(form.skipOutroSeconds) || 0),
      proxyPrefetchCount: Math.max(0, Math.min(8, Number(form.proxyPrefetchCount) || 0)),
      proxyCacheMegabytes: Math.max(32, Math.min(512, Number(form.proxyCacheMegabytes) || 128))
    }
    const saved = await window.api.settings.save(payload)
    if (newApiKey.value.trim()) {
      await window.api.settings.setApiKey(newApiKey.value.trim())
      apiKeyConfigured.value = true
    }
    Object.assign(form, DEFAULT_SETTINGS, saved)
    headersJson.value = JSON.stringify(saved.llmHttpHeaders, null, 2)
    newApiKey.value = ''
    emit('notify', 'success', '设置已保存', '新的播放任务会立即使用这些配置')
  } catch (error) {
    emit('notify', 'danger', '保存失败', errorMessage(error))
  } finally {
    saving.value = false
  }
}

async function clearKey(): Promise<void> {
  if (saving.value || testing.value) return
  saving.value = true
  try {
    await window.api.settings.clearApiKey()
    apiKeyConfigured.value = false
    newApiKey.value = ''
    emit('notify', 'success', '模型密钥已清除')
  } catch (error) {
    emit('notify', 'danger', '清除失败', errorMessage(error))
  } finally {
    saving.value = false
  }
}

onMounted(() => loadSettings())
</script>

<template>
  <section class="page settings-page">
    <header class="page-header">
      <div>
        <span class="eyebrow"><span class="eyebrow-dot"></span>PREFERENCES</span>
        <h1>偏好设置</h1>
        <p>调整规则生成、播放体验和本地预取策略。</p>
      </div>
      <button type="button" class="primary-button" :disabled="saving || loading || testing" @click="saveSettings">
        <span v-if="saving" class="spinner small"></span><UiIcon v-else name="check" :size="18" />
        {{ saving ? '正在保存…' : '保存更改' }}
      </button>
    </header>

    <div v-if="loading" class="settings-layout">
      <div v-for="index in 3" :key="index" class="settings-card skeleton-settings">
        <span class="skeleton skeleton-line medium"></span>
        <span class="skeleton skeleton-block"></span>
      </div>
    </div>

    <div v-else class="settings-layout">
      <section class="settings-card wide-settings-card llm-settings-card">
        <header class="settings-card-header">
          <span class="settings-card-icon violet"><UiIcon name="sparkles" :size="21" /></span>
          <div>
            <h2>规则生成模型</h2>
            <p>支持 Chat Completions、Responses 及接口兼容服务，密钥由系统安全存储加密。</p>
          </div>
          <span class="config-state" :class="{ ready: apiKeyConfigured }">
            <i></i>{{ apiKeyConfigured ? '密钥已配置' : '尚未配置密钥' }}
          </span>
        </header>
        <div class="settings-fields two-columns">
          <label class="field-group full-field">
            <span>API Base URL</span>
            <input v-model="form.llmApiBaseUrl" type="url" placeholder="https://api.openai.com/v1" />
            <small>填写以 /v1 结尾的基础地址，程序会根据接口类型拼接请求路径。</small>
          </label>
          <label class="field-group full-field">
            <span>接口类型</span>
            <select v-model="form.llmApiType">
              <option value="chat_completions">Chat Completions · /chat/completions</option>
              <option value="responses">Responses · /responses</option>
            </select>
            <small>配置中 wire_api = "responses" 时，选择 Responses。</small>
          </label>
          <label class="field-group">
            <span>模型名称</span>
            <input v-model="form.llmModel" type="text" placeholder="gpt-4.1-mini" />
          </label>
          <label class="field-group key-field">
            <span>{{ apiKeyConfigured ? '替换 API Key' : 'API Key' }}</span>
            <span class="password-input">
              <input
                v-model="newApiKey"
                :type="keyVisible ? 'text' : 'password'"
                autocomplete="new-password"
                :placeholder="apiKeyConfigured ? '留空以保留当前密钥' : 'sk-…'"
              />
              <button type="button" @click="keyVisible = !keyVisible">{{ keyVisible ? '隐藏' : '显示' }}</button>
            </span>
          </label>
          <label class="field-group full-field">
            <span>自定义请求头（JSON，可选）</span>
            <textarea
              v-model="headersJson"
              class="llm-headers-input"
              spellcheck="false"
              :aria-invalid="Boolean(headersError)"
              aria-describedby="llm-headers-help"
              :placeholder="JSON.stringify({ 'x-openai-actor-authorization': 'local-image-extension' }, null, 2)"
              @input="headersError = ''"
            ></textarea>
            <small id="llm-headers-help">对应配置中的 http_headers；无需额外请求头时填写 {}。API Key 会自动作为 Bearer 凭据发送。</small>
          </label>
          <div v-if="headersError" class="field-error full-field llm-settings-error" role="alert">{{ headersError }}</div>
          <label class="remember-key full-field">
            <input v-model="form.llmStoreResponses" type="checkbox" />
            <span>允许接口服务保存模型响应（默认关闭，对应 store: false）</span>
          </label>
        </div>
        <div class="llm-test-actions">
          <button type="button" class="secondary-button" :disabled="testing || saving" @click="testConnection">
            <span v-if="testing" class="spinner small"></span><UiIcon v-else name="refresh" :size="17" />
            {{ testing ? '正在测试连接…' : '测试连接' }}
          </button>
          <p>使用当前填写的配置发送一次简短模型请求，最长等待 45 秒，可能产生少量 API 费用。密钥留空时使用已保存的密钥。</p>
        </div>
        <p v-if="testing" class="llm-test-progress" role="status">正在验证模型的实际响应能力，请稍候…</p>
        <section
          v-if="testResult"
          class="llm-test-result"
          :class="{ success: testResult.success && !testResultStale, stale: testResultStale }"
          aria-label="模型连接测试结果"
          aria-live="polite"
          :aria-busy="testing"
        >
          <header>
            <strong>{{ testResultStale ? '配置已修改，请重新测试' : testResult.success ? '连接测试成功' : '连接测试失败' }}</strong>
            <span>耗时 {{ (testResult.elapsedMs / 1000).toFixed(2) }} 秒</span>
          </header>
          <p v-if="testResultStale" class="llm-test-stale">以下结果来自修改前的配置。</p>
          <p>{{ testResult.summary }}</p>
          <dl class="llm-test-metadata">
            <template v-if="testResult.apiType">
              <dt>接口类型</dt><dd>{{ testResult.apiType === 'responses' ? 'Responses' : 'Chat Completions' }}</dd>
            </template>
            <template v-if="testResult.model"><dt>模型</dt><dd>{{ testResult.model }}</dd></template>
            <template v-if="testResult.endpoint"><dt>请求地址</dt><dd>{{ testResult.endpoint }}</dd></template>
            <template v-if="testResult.httpStatus"><dt>HTTP 状态</dt><dd>{{ testResult.httpStatus }}</dd></template>
            <template v-if="testResult.requestId"><dt>请求 ID</dt><dd>{{ testResult.requestId }}</dd></template>
            <template v-if="testResult.retryAfter"><dt>Retry-After</dt><dd>{{ testResult.retryAfter }}（服务商返回的重试提示）</dd></template>
          </dl>
          <pre>{{ testResult.details }}</pre>
          <div class="llm-test-copy">
            <button type="button" class="secondary-button" @click="copyTestResult">复制测试详情</button>
            <span role="status">{{ copyFeedback }}</span>
          </div>
        </section>
        <p class="llm-test-save-hint">测试不会自动保存配置。确认后点击右上角“保存更改”，规则生成才会使用这些设置。</p>
        <button v-if="apiKeyConfigured" type="button" class="text-danger-button" :disabled="saving || testing" @click="clearKey">
          清除已保存的模型密钥
        </button>
      </section>

      <section class="settings-card">
        <header class="settings-card-header">
          <span class="settings-card-icon cyan"><UiIcon name="play" :size="21" /></span>
          <div><h2>播放行为</h2><p>断点续播始终启用并保存在本机。</p></div>
        </header>
        <div class="setting-rows">
          <label class="setting-row">
            <span><strong>自动播放下一集</strong><small>当前剧集播放完成后无缝切换</small></span>
            <input v-model="form.autoPlayNext" class="switch-input" type="checkbox" />
          </label>
          <div class="setting-row">
            <span><strong>清晰度策略</strong><small>首版自动选择站点提供的最高码率</small></span>
            <span class="fixed-value">最高可用</span>
          </div>
          <div class="setting-row dual-number-row">
            <span><strong>片头与片尾</strong><small>播放器中可一键跳过设定秒数</small></span>
            <div>
              <label>片头 <input v-model.number="form.skipIntroSeconds" type="number" min="0" max="900" /> 秒</label>
              <label>片尾 <input v-model.number="form.skipOutroSeconds" type="number" min="0" max="900" /> 秒</label>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card-header">
          <span class="settings-card-icon amber"><UiIcon name="refresh" :size="21" /></span>
          <div><h2>本地预取</h2><p>在内存中提前下载后续 HLS 分片。</p></div>
        </header>
        <div class="prefetch-control">
          <div class="prefetch-value"><strong>{{ form.proxyPrefetchCount }}</strong><span>个后续分片</span></div>
          <input v-model.number="form.proxyPrefetchCount" type="range" min="0" max="8" step="1" />
          <div class="range-labels"><span>关闭</span><span>均衡</span><span>激进</span></div>
        </div>
        <label class="cache-limit">
          <span><strong>内存缓存上限</strong><small>所有会话共享，超出后自动淘汰最早分片</small></span>
          <span><input v-model.number="form.proxyCacheMegabytes" type="number" min="32" max="512" step="16" /> MB</span>
        </label>
        <div class="info-callout">
          <UiIcon name="alert" :size="17" />
          <p>遇到上游限流时，代理会自动降低并发，不需要手动调整。</p>
        </div>
      </section>

      <section class="settings-card about-card">
        <header class="settings-card-header">
          <span class="settings-card-icon neutral"><UiIcon name="film" :size="21" /></span>
          <div><h2>内容与隐私</h2><p>影梭不会绕过 DRM 或内容授权。</p></div>
        </header>
        <ul>
          <li><UiIcon name="check" :size="14" />仅使用你有权访问的内容站点</li>
          <li><UiIcon name="check" :size="14" />搜索、历史与代理数据留在当前设备</li>
          <li><UiIcon name="check" :size="14" />关闭应用后临时嗅探会话自动销毁</li>
        </ul>
      </section>
    </div>
  </section>
</template>
