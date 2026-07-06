<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCard, NProgress } from 'naive-ui'
import { fetchCurrentUser, updateMyModelGuideStatus } from '@/api/auth'
import { getApiKey } from '@/api/client'
import { useModelsStore } from '@/stores/hermes/models'
import { useI18n } from 'vue-i18n'

type GuideStep = {
  titleKey: string
  descriptionKey: string
  hintKey?: string
  routeName?: string
  query?: Record<string, string>
  targetId?: string
}

const route = useRoute()
const router = useRouter()
const modelsStore = useModelsStore()
const { t } = useI18n()

const show = ref(false)
const checking = ref(false)
const currentStep = ref(0)
const checkedToken = ref('')
const anchorRect = ref<DOMRect | null>(null)
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)
const viewportHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 800)

const steps = computed<GuideStep[]>(() => ([
  {
    titleKey: 'modelGuide.steps.welcome.title',
    descriptionKey: 'modelGuide.steps.welcome.description',
    hintKey: 'modelGuide.steps.welcome.hint',
  },
  {
    titleKey: 'modelGuide.steps.settings.title',
    descriptionKey: 'modelGuide.steps.settings.description',
    hintKey: 'modelGuide.steps.settings.hint',
    routeName: 'hermes.settings',
    query: { tab: 'models' },
    targetId: 'settings-models-panel',
  },
  {
    titleKey: 'modelGuide.steps.addProvider.title',
    descriptionKey: 'modelGuide.steps.addProvider.description',
    hintKey: 'modelGuide.steps.addProvider.hint',
    routeName: 'hermes.models',
    targetId: 'models-add-provider',
  },
  {
    titleKey: 'modelGuide.steps.providerList.title',
    descriptionKey: 'modelGuide.steps.providerList.description',
    hintKey: 'modelGuide.steps.providerList.hint',
    routeName: 'hermes.models',
    targetId: 'models-provider-list',
  },
  {
    titleKey: 'modelGuide.steps.complete.title',
    descriptionKey: 'modelGuide.steps.complete.description',
    hintKey: 'modelGuide.steps.complete.hint',
    routeName: 'hermes.models',
  },
]))

const progressValue = computed(() => ((currentStep.value + 1) / steps.value.length) * 100)

const spotlightStyle = computed(() => {
  const rect = anchorRect.value
  if (!rect) return {}
  return {
    top: `${Math.max(rect.top - 10, 8)}px`,
    left: `${Math.max(rect.left - 10, 8)}px`,
    width: `${Math.max(rect.width + 20, 56)}px`,
    height: `${Math.max(rect.height + 20, 56)}px`,
  }
})

const panelWidth = computed(() => {
  if (viewportWidth.value < 640) return Math.min(viewportWidth.value - 24, 340)
  return 360
})

const panelPlacement = computed<'right' | 'left' | 'top' | 'bottom' | 'floating'>(() => {
  const rect = anchorRect.value
  if (!rect) return 'floating'
  const spaceRight = viewportWidth.value - rect.right
  const spaceLeft = rect.left
  const spaceBottom = viewportHeight.value - rect.bottom
  const spaceTop = rect.top
  const minSideSpace = panelWidth.value + 40
  if (spaceRight >= minSideSpace) return 'right'
  if (spaceLeft >= minSideSpace) return 'left'
  if (spaceBottom >= 260) return 'bottom'
  if (spaceTop >= 260) return 'top'
  return 'floating'
})

const panelStyle = computed(() => {
  const rect = anchorRect.value
  const width = panelWidth.value
  const gap = 20
  const minMargin = 12

  if (!rect || panelPlacement.value === 'floating') {
    return {
      width: `${width}px`,
      right: `${Math.max(12, minMargin)}px`,
      bottom: `${Math.max(12, minMargin)}px`,
    }
  }

  const clampLeft = (value: number) => {
    const maxLeft = viewportWidth.value - width - minMargin
    return Math.min(Math.max(value, minMargin), Math.max(minMargin, maxLeft))
  }

  if (panelPlacement.value === 'right') {
    return {
      width: `${width}px`,
      left: `${clampLeft(rect.right + gap)}px`,
      top: `${Math.max(minMargin, rect.top + rect.height / 2 - 110)}px`,
    }
  }
  if (panelPlacement.value === 'left') {
    return {
      width: `${width}px`,
      left: `${clampLeft(rect.left - width - gap)}px`,
      top: `${Math.max(minMargin, rect.top + rect.height / 2 - 110)}px`,
    }
  }
  if (panelPlacement.value === 'bottom') {
    return {
      width: `${width}px`,
      left: `${clampLeft(rect.left + rect.width / 2 - width / 2)}px`,
      top: `${Math.min(viewportHeight.value - 220, rect.bottom + gap)}px`,
    }
  }
  return {
    width: `${width}px`,
    left: `${clampLeft(rect.left + rect.width / 2 - width / 2)}px`,
    top: `${Math.max(minMargin, rect.top - 220 - gap)}px`,
  }
})

const panelClass = computed(() => `model-guide__panel--${panelPlacement.value}`)

function isDesktopShell(): boolean {
  return (window as typeof window & { hermesDesktop?: { isDesktop?: boolean } }).hermesDesktop?.isDesktop === true
}

function matchesStepRoute(step: GuideStep): boolean {
  if (!step.routeName) return true
  if (route.name !== step.routeName) return false
  if (!step.query) return true
  return Object.entries(step.query).every(([key, value]) => route.query[key] === value)
}

function currentTargetElement(): HTMLElement | null {
  const targetId = steps.value[currentStep.value]?.targetId
  if (!targetId) return null
  return document.querySelector(`[data-guide-id="${targetId}"]`) as HTMLElement | null
}

function updateAnchorRect(): void {
  const element = currentTargetElement()
  anchorRect.value = element ? element.getBoundingClientRect() : null
}

function updateViewportMetrics(): void {
  viewportWidth.value = window.innerWidth
  viewportHeight.value = window.innerHeight
}

async function focusCurrentTarget(): Promise<void> {
  await nextTick()
  const element = currentTargetElement()
  if (!element) {
    anchorRect.value = null
    return
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  window.setTimeout(updateAnchorRect, 180)
}

async function ensureProvidersLoaded(): Promise<void> {
  if (!getApiKey()) return
  if (modelsStore.providers.length > 0 || modelsStore.loading) return
  try {
    await modelsStore.fetchProviders()
  } catch {
    // Ignore guide prefetch failures and let the regular UI report them.
  }
}

async function syncStepView(): Promise<void> {
  if (!show.value) return
  const step = steps.value[currentStep.value]
  if (step.routeName && !matchesStepRoute(step)) {
    await router.push({
      name: step.routeName,
      ...(step.query ? { query: { ...route.query, ...step.query } } : {}),
    })
  }
  if (step.routeName === 'hermes.settings' || step.routeName === 'hermes.models') {
    await ensureProvidersLoaded()
  }
  await focusCurrentTarget()
}

async function checkGuide(): Promise<void> {
  if (isDesktopShell() || route.name === 'login') {
    show.value = false
    anchorRect.value = null
    return
  }

  const token = getApiKey()
  if (!token) {
    checkedToken.value = ''
    show.value = false
    anchorRect.value = null
    return
  }

  if (checkedToken.value === token && !show.value) return
  if (checkedToken.value === token && show.value) {
    await syncStepView()
    return
  }

  checking.value = true
  try {
    const user = await fetchCurrentUser()
    checkedToken.value = token
    show.value = user.shouldShowModelGuide === true
    currentStep.value = 0
    if (show.value) {
      await syncStepView()
    } else {
      anchorRect.value = null
    }
  } catch {
    show.value = false
    anchorRect.value = null
  } finally {
    checking.value = false
  }
}

async function handleSkip(): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    await updateMyModelGuideStatus('skipped')
    show.value = false
    anchorRect.value = null
  } finally {
    checking.value = false
  }
}

async function handleComplete(): Promise<void> {
  if (checking.value || !modelsStore.hasCompletedInitialSetup) return
  checking.value = true
  try {
    await updateMyModelGuideStatus('completed')
    show.value = false
    anchorRect.value = null
  } finally {
    checking.value = false
  }
}

async function handleNext(): Promise<void> {
  if (currentStep.value >= steps.value.length - 1) return
  currentStep.value += 1
  await syncStepView()
}

async function handlePrev(): Promise<void> {
  if (currentStep.value <= 0) return
  currentStep.value -= 1
  await syncStepView()
}

function handleViewportChange(): void {
  if (!show.value) return
  updateViewportMetrics()
  updateAnchorRect()
}

watch(() => route.fullPath, () => {
  if (show.value) {
    void syncStepView()
    return
  }
  void checkGuide()
}, { immediate: true })

watch(() => modelsStore.hasCompletedInitialSetup, (completed) => {
  if (show.value && completed && currentStep.value < steps.value.length - 1) {
    currentStep.value = steps.value.length - 1
    void syncStepView()
  }
})

onMounted(() => {
  updateViewportMetrics()
  window.addEventListener('resize', handleViewportChange)
  window.addEventListener('scroll', handleViewportChange, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleViewportChange)
  window.removeEventListener('scroll', handleViewportChange, true)
})
</script>

<template>
  <div v-if="show" class="model-guide">
    <div class="model-guide__mask" />
    <div v-if="anchorRect" class="model-guide__spotlight" :style="spotlightStyle" />

    <div class="model-guide__panel" :class="panelClass" :style="panelStyle">
      <NCard size="large" :bordered="false">
        <div class="model-guide__eyebrow">
          <span class="model-guide__eyebrow-label">{{ t('modelGuide.progress', { current: currentStep + 1, total: steps.length }) }}</span>
          <span class="model-guide__eyebrow-value">{{ Math.round(progressValue) }}%</span>
        </div>
        <NProgress
          class="model-guide__progress"
          type="line"
          :percentage="progressValue"
          :show-indicator="false"
          :height="8"
        />
        <h3 class="model-guide__title">{{ t(steps[currentStep].titleKey) }}</h3>
        <p class="model-guide__description">{{ t(steps[currentStep].descriptionKey) }}</p>
        <p v-if="steps[currentStep].hintKey" class="model-guide__hint">
          {{ t(steps[currentStep].hintKey!) }}
        </p>
        <p
          v-if="currentStep === steps.length - 1 && !modelsStore.hasCompletedInitialSetup"
          class="model-guide__pending"
        >
          {{ t('modelGuide.steps.complete.pending') }}
        </p>

        <div class="model-guide__actions">
          <NButton tertiary :disabled="checking" @click="handleSkip">
            {{ t('modelGuide.skip') }}
          </NButton>
          <NButton v-if="currentStep > 0" :disabled="checking" @click="handlePrev">
            {{ t('modelGuide.previous') }}
          </NButton>
          <NButton
            v-if="currentStep < steps.length - 1"
            type="primary"
            :loading="checking"
            @click="handleNext"
          >
            {{ t('modelGuide.next') }}
          </NButton>
          <NButton
            v-else
            type="primary"
            :loading="checking"
            :disabled="!modelsStore.hasCompletedInitialSetup"
            @click="handleComplete"
          >
            {{ t('modelGuide.complete') }}
          </NButton>
        </div>
      </NCard>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.model-guide {
  position: fixed;
  inset: 0;
  z-index: 4600;
  pointer-events: none;
}

.model-guide__mask {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at top right, rgba(91, 134, 255, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(6, 10, 18, 0.18), rgba(6, 10, 18, 0.32));
}

.model-guide__spotlight {
  position: fixed;
  z-index: 1;
  border-radius: 18px;
  border: 1px solid rgba(214, 227, 255, 0.92);
  background: rgba(132, 170, 255, 0.06);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.18) inset,
    0 0 0 6px rgba(99, 134, 255, 0.18),
    0 0 0 9999px rgba(4, 8, 16, 0.44),
    0 16px 44px rgba(10, 16, 32, 0.24);
  animation: guide-pulse 1.8s ease-in-out infinite;
}

.model-guide__panel {
  position: fixed;
  z-index: 2;
  pointer-events: auto;
}

.model-guide__panel :deep(.n-card) {
  position: relative;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(34, 40, 54, 0.96), rgba(21, 25, 37, 0.96)),
    color-mix(in srgb, $bg-card 92%, #fff);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow:
    0 22px 50px rgba(0, 0, 0, 0.34),
    0 0 0 1px rgba(255, 255, 255, 0.04) inset;
  border-radius: 20px;
  backdrop-filter: blur(12px);
}

.model-guide__panel :deep(.n-card)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: linear-gradient(90deg, #7ad7ff, #8ea3ff 42%, #f0f4ff);
  opacity: 0.95;
}

.model-guide__panel::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: rgba(31, 37, 53, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transform: rotate(45deg);
}

.model-guide__panel--right::after {
  left: -6px;
  top: 44px;
}

.model-guide__panel--left::after {
  right: -6px;
  top: 44px;
}

.model-guide__panel--bottom::after {
  top: -6px;
  left: 42px;
}

.model-guide__panel--top::after {
  bottom: -6px;
  left: 42px;
}

.model-guide__panel--floating::after {
  display: none;
}

.model-guide__eyebrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: rgba(224, 231, 255, 0.78);
}

.model-guide__eyebrow-label {
  letter-spacing: 0.02em;
}

.model-guide__eyebrow-value {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(122, 215, 255, 0.12);
  color: #d9efff;
  font-weight: 600;
}

.model-guide__progress {
  margin-top: 12px;
}

.model-guide__title {
  margin: 16px 0 8px;
  font-size: 22px;
  line-height: 1.28;
  font-weight: 700;
  color: #f5f7ff;
}

.model-guide__description,
.model-guide__hint,
.model-guide__pending {
  margin: 0;
  line-height: 1.7;
}

.model-guide__description {
  color: rgba(239, 243, 255, 0.92);
}

.model-guide__hint {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(199, 209, 235, 0.88);
}

.model-guide__pending {
  margin-top: 12px;
  color: #ffd28a;
}

.model-guide__actions {
  margin-top: 18px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

@keyframes guide-pulse {
  0%, 100% {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.18) inset,
      0 0 0 6px rgba(99, 134, 255, 0.14),
      0 0 0 9999px rgba(4, 8, 16, 0.44),
      0 16px 44px rgba(10, 16, 32, 0.24);
  }
  50% {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.26) inset,
      0 0 0 10px rgba(99, 134, 255, 0.22),
      0 0 0 9999px rgba(4, 8, 16, 0.44),
      0 20px 54px rgba(10, 16, 32, 0.28);
  }
}

@media (max-width: 640px) {
  .model-guide__panel {
    max-width: calc(100vw - 24px);
  }

  .model-guide__panel::after {
    display: none;
  }

  .model-guide__title {
    font-size: 20px;
  }
}
</style>
