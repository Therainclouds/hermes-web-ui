<script setup lang="ts">
/**
 * ExpertCover - 封面/图标渲染
 * - 优先使用 icon_url / cover_url
 * - 缺图时根据 slug 派生稳定的渐变 + 首字母占位（基于 hash 选角度与浅灰深浅）
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    slug: string
    iconUrl?: string | null
    coverUrl?: string | null
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { size: 'md', iconUrl: null, coverUrl: null },
)

const hasCover = computed(() => !!props.coverUrl || !!props.iconUrl)
const coverSrc = computed(() => props.coverUrl || props.iconUrl || '')

const initials = computed(() => {
  const trimmed = (props.name || props.slug || '?').trim()
  if (!trimmed) return '?'
  // 中文：取首个汉字；英文：取首字母
  const first = trimmed[0]
  return first ? first.toUpperCase() : '?'
})

// 基于 slug 哈希生成稳定的角度与暗度，保持不同卡片之间的视觉差异
const hash = computed(() => {
  let h = 0
  for (let i = 0; i < props.slug.length; i += 1) {
    h = (h * 31 + props.slug.charCodeAt(i)) | 0
  }
  return Math.abs(h)
})

const angle = computed(() => `${hash.value % 360}deg`)
const tintIndex = computed(() => hash.value % 4) // 0..3 共 4 种暗度

const sizeMap: Record<NonNullable<typeof props.size>, string> = {
  sm: '44px',
  md: '72px',
  lg: '160px',
}
</script>

<template>
  <div class="expert-cover" :class="['size-' + size]" :style="{ width: sizeMap[size], height: sizeMap[size] }">
    <img v-if="hasCover" :src="coverSrc" :alt="name" class="cover-img" />
    <div
      v-else
      class="cover-placeholder"
      :style="{
        backgroundImage: `linear-gradient(${angle}, rgba(var(--text-primary-rgb), ${0.18 + tintIndex * 0.06}), rgba(var(--text-primary-rgb), ${0.42 + tintIndex * 0.08}))`,
      }"
    >
      <span class="initials">{{ initials }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.expert-cover {
  position: relative;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg-secondary);
}

.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-accent);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.size-sm .initials { font-size: 16px; }
.size-md .initials { font-size: 26px; }
.size-lg .initials { font-size: 56px; }
</style>