<script setup lang="ts">
import { computed } from 'vue'
import type { FavoriteInput, FavoriteItem } from '../types'
import { favoriteKey } from '../favorites'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  item: FavoriteInput
  favorites?: FavoriteItem[]
  pending?: string[]
  compact?: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{ toggle: [item: FavoriteInput] }>()
const key = computed(() => favoriteKey(props.item))
const active = computed(() => props.favorites?.some((item) => favoriteKey(item) === key.value) || false)
const busy = computed(() => props.pending?.includes(key.value) || false)
const label = computed(() => `${active.value ? '取消收藏' : '收藏'}《${props.item.title}》`)
</script>

<template>
  <button
    type="button"
    class="favorite-button"
    :class="{ active, compact }"
    :aria-label="label"
    :aria-pressed="active"
    :title="label"
    :disabled="disabled || busy"
    @click.stop="emit('toggle', item)"
  >
    <span v-if="busy" class="spinner small"></span>
    <UiIcon v-else name="bookmark" :size="17" />
    <span v-if="!compact">{{ active ? '已收藏' : '收藏' }}</span>
  </button>
</template>
