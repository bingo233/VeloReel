<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { RuleGenerationProgress } from '../../../shared/types'
import UiIcon from '../components/UiIcon.vue'
import type { GenerateRuleInput, SiteRule, ToastMessage } from '../types'
import { errorMessage, formatRelativeTime, safeHostname } from '../utils'

const emit = defineEmits<{
  changed: []
  notify: [tone: ToastMessage['tone'], title: string, message?: string]
}>()

type EditorMode = 'closed' | 'generate' | 'json'

const rules = ref<SiteRule[]>([])
const loading = ref(true)
const loadError = ref('')
const editorMode = ref<EditorMode>('closed')
const editingRule = ref<SiteRule | null>(null)
const jsonValue = ref('')
const jsonError = ref('')
const generationError = ref('')
const generationProgress = ref<RuleGenerationProgress | null>(null)
let stopGenerationProgress: (() => void) | undefined
const generationErrorPanel = ref<HTMLElement | null>(null)
const errorCopied = ref(false)
const errorCopyFailed = ref(false)
const saving = ref(false)
const pendingDelete = ref<SiteRule | null>(null)
const generation = ref<GenerateRuleInput>({
  siteUrl: '',
  searchResultUrl: '',
  detailUrl: '',
  playPageUrl: '',
  apiKey: '',
  apiBaseUrl: '',
  apiType: undefined,
  model: '',
  rememberApiKey: true
})

const sortedRules = computed(() =>
  [...rules.value].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
)

async function loadRules(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    rules.value = await window.api.rules.list()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

function openGenerate(): void {
  generationError.value = ''
  generationProgress.value = null
  errorCopied.value = false
  errorCopyFailed.value = false
  generation.value = {
    siteUrl: '',
    searchResultUrl: '',
    detailUrl: '',
    playPageUrl: '',
    apiKey: '',
    apiBaseUrl: '',
    apiType: undefined,
    model: '',
    rememberApiKey: true
  }
  editorMode.value = 'generate'
}

function defaultRule(): SiteRule {
  return {
    siteId: 'my_site',
    siteName: '我的站点',
    baseUrl: 'https://example.com',
    search: {
      urlTemplate: 'https://example.com/search?wd={keyword}',
      listSelector: '.search-item',
      titleSelector: '.title',
      detailUrlSelector: 'a@href',
      coverUrlSelector: 'img@src'
    },
    detail: {
      playlistGroupSelector: '.playlist-title',
      episodeGroupSelector: '.playlist',
      episodeListSelector: '.episode-list a',
      episodeNameSelector: '@text',
      episodeUrlSelector: '@href'
    },
    streamExtraction: {
      primaryMode: 'static',
      staticRule: {
        regex: '"url"\\s*:\\s*"([^"]+)"',
        decodePipeline: ['unescape_slashes'],
        validUrlPattern: '^https?://.*\\.(m3u8|mp4)(\\?.*)?$'
      },
      fallbackMode: 'sniffer',
      snifferRule: {
        timeoutMs: 12000,
        urlMatchRegex: '\\.(m3u8|mp4)(\\?.*)?$',
        excludeRegex: '(ad|tracker|analytics|doubleclick)'
      }
    }
  }
}

function openJson(rule?: SiteRule): void {
  editingRule.value = rule || null
  jsonValue.value = JSON.stringify(rule || defaultRule(), null, 2)
  jsonError.value = ''
  editorMode.value = 'json'
}

function closeEditor(): void {
  if (saving.value) return
  editorMode.value = 'closed'
  editingRule.value = null
  jsonError.value = ''
  generationError.value = ''
}

async function generateRule(): Promise<void> {
  if (saving.value || !generation.value.siteUrl.trim()) return
  saving.value = true
  generationError.value = ''
  errorCopied.value = false
  errorCopyFailed.value = false
  try {
    generationProgress.value = { stage: 'explore', message: '正在准备自动探索站点…' }
    stopGenerationProgress = window.api.rules.onGenerationProgress((progress) => { generationProgress.value = progress })
    const payload: GenerateRuleInput = {
      siteUrl: generation.value.siteUrl.trim(),
      ...(generation.value.searchResultUrl?.trim()
        ? { searchResultUrl: generation.value.searchResultUrl.trim() }
        : {}),
      ...(generation.value.detailUrl?.trim() ? { detailUrl: generation.value.detailUrl.trim() } : {}),
      ...(generation.value.playPageUrl?.trim()
        ? { playPageUrl: generation.value.playPageUrl.trim() }
        : {}),
      ...(generation.value.apiKey?.trim() ? { apiKey: generation.value.apiKey.trim() } : {}),
      ...(generation.value.apiBaseUrl?.trim()
        ? { apiBaseUrl: generation.value.apiBaseUrl.trim() }
        : {}),
      ...(generation.value.model?.trim() ? { model: generation.value.model.trim() } : {}),
      ...(generation.value.apiType ? { apiType: generation.value.apiType } : {}),
      rememberApiKey: Boolean(generation.value.rememberApiKey)
    }
    const rule = await window.api.rules.generate(payload)
    const index = rules.value.findIndex((item) => item.siteId === rule.siteId)
    if (index >= 0) rules.value.splice(index, 1, rule)
    else rules.value.push(rule)
    editorMode.value = 'closed'
    emit('changed')
    emit('notify', 'success', `${rule.siteName} 已连接`, '已自动获取各类页面，搜索、选集和播放地址提取已通过验证')
  } catch (error) {
    generationError.value = errorMessage(error)
    await nextTick()
    generationErrorPanel.value?.focus({ preventScroll: true })
    generationErrorPanel.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  } finally {
    stopGenerationProgress?.()
    stopGenerationProgress = undefined
    saving.value = false
  }
}

async function copyGenerationError(): Promise<void> {
  try {
    await navigator.clipboard.writeText(`规则生成失败\n\n${generationError.value}`)
    errorCopied.value = true
    errorCopyFailed.value = false
  } catch {
    errorCopied.value = false
    errorCopyFailed.value = true
  }
}

function parseJson(): SiteRule | null {
  jsonError.value = ''
  try {
    const value = JSON.parse(jsonValue.value) as SiteRule
    if (!value || typeof value !== 'object') throw new Error('根节点必须是 JSON 对象')
    if (!value.siteId?.trim()) throw new Error('缺少 siteId')
    if (!value.siteName?.trim()) throw new Error('缺少 siteName')
    if (!value.baseUrl?.trim()) throw new Error('缺少 baseUrl')
    if (!value.search?.urlTemplate) throw new Error('缺少 search.urlTemplate')
    if (!value.detail?.episodeListSelector) throw new Error('缺少 detail.episodeListSelector')
    if (!value.streamExtraction) throw new Error('缺少 streamExtraction')
    return value
  } catch (error) {
    jsonError.value = errorMessage(error)
    return null
  }
}

async function saveJson(): Promise<void> {
  if (saving.value) return
  const value = parseJson()
  if (!value) return
  saving.value = true
  try {
    const saved = await window.api.rules.save(value)
    const index = rules.value.findIndex((item) => item.siteId === saved.siteId)
    if (index >= 0) rules.value.splice(index, 1, saved)
    else rules.value.push(saved)
    editorMode.value = 'closed'
    editingRule.value = null
    emit('changed')
    emit('notify', 'success', `${saved.siteName} 已保存`)
  } catch (error) {
    jsonError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

async function removeRule(): Promise<void> {
  if (!pendingDelete.value || saving.value) return
  saving.value = true
  try {
    await window.api.rules.remove(pendingDelete.value.siteId)
    rules.value = rules.value.filter((item) => item.siteId !== pendingDelete.value?.siteId)
    pendingDelete.value = null
    emit('changed')
    emit('notify', 'success', '站点规则已移除')
  } catch (error) {
    emit('notify', 'danger', '移除失败', errorMessage(error))
  } finally {
    saving.value = false
  }
}

async function copyRule(rule: SiteRule): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(rule, null, 2))
    emit('notify', 'success', '规则 JSON 已复制')
  } catch {
    emit('notify', 'warning', '无法访问剪贴板', '可点击编辑后手动复制 JSON')
  }
}

onMounted(() => loadRules())
onUnmounted(() => stopGenerationProgress?.())
</script>

<template>
  <section class="page rules-page">
    <header class="page-header">
      <div>
        <span class="eyebrow"><span class="eyebrow-dot"></span>SOURCE LIBRARY</span>
        <h1>站点规则</h1>
        <p>管理搜索、选集与视频流解析规则，所有配置仅保存在本机。</p>
      </div>
      <div class="header-actions">
        <button type="button" class="ghost-button" @click="openJson()">
          <UiIcon name="upload" :size="17" />导入 JSON
        </button>
        <button type="button" class="primary-button" @click="openGenerate">
          <UiIcon name="sparkles" :size="18" />AI 生成规则
        </button>
      </div>
    </header>

    <div class="security-note">
      <span><UiIcon name="key" :size="19" /></span>
      <div>
        <strong>本地优先，凭据安全</strong>
        <p>页面解析与视频代理都在当前设备运行；模型密钥由系统安全存储保护。</p>
      </div>
    </div>

    <div v-if="loading" class="rule-list">
      <article v-for="index in 4" :key="index" class="rule-card skeleton-rule">
        <span class="skeleton rule-avatar"></span>
        <div><span class="skeleton skeleton-line wide"></span><span class="skeleton skeleton-line"></span></div>
      </article>
    </div>

    <div v-else-if="loadError" class="state-panel error-state compact-state">
      <span class="state-icon"><UiIcon name="alert" :size="28" /></span>
      <h2>无法读取站点规则</h2>
      <p>{{ loadError }}</p>
      <button type="button" class="secondary-button" @click="loadRules">
        <UiIcon name="refresh" :size="17" />重试
      </button>
    </div>

    <div v-else-if="!rules.length" class="state-panel rules-empty">
      <div class="empty-orbit compact"><span class="empty-orbit-ring"></span><span class="state-icon"><UiIcon name="globe" :size="31" /></span></div>
      <span class="eyebrow">NO SOURCES YET</span>
      <h2>添加第一个内容站点</h2>
      <p>让 AI 读取站点结构并生成规则，或导入已有的规则 JSON。</p>
      <div class="header-actions">
        <button type="button" class="secondary-button" @click="openJson()"><UiIcon name="upload" :size="17" />导入 JSON</button>
        <button type="button" class="primary-button" @click="openGenerate"><UiIcon name="sparkles" :size="18" />AI 生成规则</button>
      </div>
    </div>

    <div v-else class="rule-list">
      <article v-for="rule in sortedRules" :key="rule.siteId" class="rule-card">
        <span class="rule-avatar">{{ rule.siteName.slice(0, 1).toUpperCase() }}</span>
        <div class="rule-main">
          <div class="rule-title-row">
            <h2>{{ rule.siteName }}</h2>
            <span class="enabled-chip"><i></i>已启用</span>
          </div>
          <span class="rule-host">{{ safeHostname(rule.baseUrl) }}</span>
          <div class="rule-capabilities">
            <span><UiIcon name="check" :size="12" />搜索</span>
            <span><UiIcon name="check" :size="12" />选集</span>
            <span><UiIcon name="check" :size="12" />{{ rule.streamExtraction.fallbackMode === 'sniffer' ? '双级提取' : '静态提取' }}</span>
          </div>
        </div>
        <div class="rule-meta">
          <span>{{ rule.updatedAt ? formatRelativeTime(rule.updatedAt) + '更新' : '已保存' }}</span>
          <small>{{ rule.siteId }}</small>
        </div>
        <div class="rule-actions">
          <button type="button" class="icon-button subtle" aria-label="复制规则" @click="copyRule(rule)"><UiIcon name="upload" :size="16" /></button>
          <button type="button" class="icon-button subtle" aria-label="编辑规则" @click="openJson(rule)"><UiIcon name="edit" :size="16" /></button>
          <button type="button" class="icon-button subtle danger-on-hover" aria-label="删除规则" @click="pendingDelete = rule"><UiIcon name="trash" :size="16" /></button>
        </div>
      </article>
    </div>

    <Transition name="modal">
      <div v-if="editorMode !== 'closed'" class="modal-backdrop editor-backdrop" @click.self="closeEditor">
        <div class="editor-dialog" role="dialog" aria-modal="true">
          <header class="editor-header">
            <div>
              <span class="eyebrow">{{ editorMode === 'generate' ? 'AI RULE BUILDER' : 'RULE EDITOR' }}</span>
              <h2>{{ editorMode === 'generate' ? '连接新站点' : editingRule ? `编辑 ${editingRule.siteName}` : '导入规则 JSON' }}</h2>
              <p>{{ editorMode === 'generate' ? '只需填写首页，AI 会自动寻找搜索、详情和播放页面，整理并验证规则。' : '保存前会检查必要字段，规则只在主进程中执行。' }}</p>
            </div>
            <button type="button" class="icon-button" aria-label="关闭" :disabled="saving" @click="closeEditor"><UiIcon name="close" :size="20" /></button>
          </header>

          <form v-if="editorMode === 'generate'" class="editor-body generation-form" @submit.prevent="generateRule">
            <section v-if="saving && generationProgress" class="generation-progress full-field" role="status" aria-live="polite">
              <strong><span class="spinner small"></span>{{ generationProgress.message }}</strong>
              <p v-if="generationProgress.url">{{ generationProgress.url }}</p>
              <small v-if="generationProgress.visitedPages">已读取 {{ generationProgress.visitedPages }} 个页面</small>
            </section>
            <section
              v-if="generationError"
              ref="generationErrorPanel"
              class="generation-error full-field"
              role="alert"
              aria-labelledby="generation-error-title"
              tabindex="-1"
            >
              <div class="generation-error-header">
                <strong id="generation-error-title"><UiIcon name="alert" :size="20" />规则生成失败</strong>
                <button type="button" class="secondary-button" @click="copyGenerationError">
                  {{ errorCopied ? '已复制错误' : '复制错误' }}
                </button>
              </div>
              <p>下面是完整错误信息。可以修改后重试，或复制详情用于排查。</p>
              <pre>{{ generationError }}</pre>
              <p v-if="errorCopyFailed" role="status">复制失败，请选中上方错误文字手动复制。</p>
            </section>
            <label class="field-group full-field">
              <span>站点首页 <b>必填</b></span>
              <input v-model="generation.siteUrl" type="url" required placeholder="https://example.com" />
              <small>AI 会沿站内实际链接访问页面，验证搜索、选集和播放地址提取后才保存规则。</small>
            </label>
            <details class="generation-sample-options full-field">
              <summary>高级选项：指定样本页面（通常无需填写）</summary>
              <div class="generation-sample-fields">
            <label class="field-group full-field">
              <span>搜索结果页 URL</span>
              <input v-model="generation.searchResultUrl" type="url" placeholder="留空由 AI 自动搜索；填写可指定搜索样本" />
              <small>如需手动指定，请使用至少有一部影片的真实搜索结果页。</small>
            </label>
            <label class="field-group">
              <span>影片详情页 URL</span>
              <input v-model="generation.detailUrl" type="url" placeholder="留空由 AI 从搜索结果中寻找" />
            </label>
            <label class="field-group">
              <span>播放页 URL</span>
              <input v-model="generation.playPageUrl" type="url" placeholder="留空由 AI 从详情页中寻找" />
            </label>
              </div>
            </details>
            <label class="field-group">
              <span>模型名称</span>
              <input v-model="generation.model" type="text" placeholder="使用设置中的默认模型" />
            </label>
            <label class="field-group">
              <span>API Base URL</span>
              <input v-model="generation.apiBaseUrl" type="url" placeholder="使用设置中的默认地址" />
            </label>
            <label class="field-group full-field">
              <span>接口类型</span>
              <select v-model="generation.apiType">
                <option :value="undefined">使用偏好设置</option>
                <option value="chat_completions">Chat Completions</option>
                <option value="responses">Responses</option>
              </select>
              <small>自定义请求头和响应保存选项沿用偏好设置。</small>
            </label>
            <label class="field-group full-field">
              <span>本次使用的 API Key</span>
              <input v-model="generation.apiKey" type="password" autocomplete="new-password" placeholder="留空则使用安全存储中的密钥" />
              <small>网页内容会被视作不可信数据，不能改变规则生成指令。</small>
            </label>
            <label v-if="generation.apiKey" class="remember-key full-field">
              <input v-model="generation.rememberApiKey" type="checkbox" />
              <span>使用系统安全存储记住这个密钥</span>
            </label>
            <div class="editor-actions full-field">
              <button type="button" class="ghost-button" :disabled="saving" @click="closeEditor">取消</button>
              <button type="submit" class="primary-button" :disabled="saving || !generation.siteUrl.trim()">
                <span v-if="saving" class="spinner small"></span><UiIcon v-else name="sparkles" :size="18" />
                {{ saving ? '正在探索并验证站点…' : '自动探索并生成规则' }}
              </button>
            </div>
          </form>

          <div v-else class="editor-body json-editor-body">
            <label class="json-editor">
              <span>站点规则 JSON</span>
              <textarea v-model="jsonValue" spellcheck="false" @input="jsonError = ''"></textarea>
            </label>
            <div v-if="jsonError" class="field-error"><UiIcon name="alert" :size="15" />{{ jsonError }}</div>
            <div class="editor-actions">
              <button type="button" class="ghost-button" :disabled="saving" @click="closeEditor">取消</button>
              <button type="button" class="primary-button" :disabled="saving" @click="saveJson">
                <span v-if="saving" class="spinner small"></span><UiIcon v-else name="check" :size="18" />
                {{ saving ? '正在校验…' : '校验并保存' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="modal">
      <div v-if="pendingDelete" class="modal-backdrop" @click.self="pendingDelete = null">
        <div class="confirm-dialog" role="dialog" aria-modal="true">
          <span class="dialog-icon danger"><UiIcon name="trash" :size="22" /></span>
          <h2>移除 {{ pendingDelete.siteName }}？</h2>
          <p>之后将无法搜索或解析该站点，已有观看历史不会被删除。</p>
          <div class="dialog-actions">
            <button type="button" class="ghost-button" @click="pendingDelete = null">取消</button>
            <button type="button" class="danger-button" :disabled="saving" @click="removeRule">{{ saving ? '处理中…' : '确认移除' }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>
