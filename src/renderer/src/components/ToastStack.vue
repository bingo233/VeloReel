<script setup lang="ts">
import { ref } from 'vue'
import type { ToastMessage } from '../types'
import UiIcon from './UiIcon.vue'

defineProps<{ messages: ToastMessage[] }>()
defineEmits<{ dismiss: [id: number] }>()

const copiedId = ref<number | null>(null)
const copyFailedId = ref<number | null>(null)

async function copyMessage(message: ToastMessage): Promise<void> {
  try {
    await navigator.clipboard.writeText([message.title, message.message].filter(Boolean).join('\n\n'))
    copiedId.value = message.id
    copyFailedId.value = null
  } catch {
    copyFailedId.value = message.id
    copiedId.value = null
  }
}
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toast-stack" aria-live="polite">
    <article
      v-for="message in messages"
      :key="message.id"
      class="toast-card"
      :class="`is-${message.tone}`"
    >
      <span class="toast-icon">
        <UiIcon :name="message.tone === 'danger' ? 'alert' : 'check'" :size="18" />
      </span>
      <div class="toast-copy">
        <strong>{{ message.title }}</strong>
        <p v-if="message.message" class="toast-message" tabindex="0">{{ message.message }}</p>
        <button v-if="message.message" type="button" class="toast-copy-button" @click="copyMessage(message)">
          {{ copiedId === message.id ? '已复制' : '复制详情' }}
        </button>
        <span v-if="copyFailedId === message.id" class="toast-copy-feedback" role="status">
          复制失败，请选中文字手动复制。
        </span>
      </div>
      <button type="button" class="icon-button toast-dismiss" aria-label="关闭提示" @click="$emit('dismiss', message.id)">
        <UiIcon name="close" :size="18" />
      </button>
    </article>
  </TransitionGroup>
</template>
