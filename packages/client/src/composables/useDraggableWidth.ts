import { computed, ref } from 'vue'

export interface DraggableWidthOptions {
  /** localStorage key used to persist the width across sessions */
  storageKey: string
  minWidth: number
  maxWidth: number
  defaultWidth: number
}

/**
 * Generic drag-to-resize width for a side panel.
 *
 * The pointer events are bound to `document` while dragging so the pointer
 * can leave the panel; listeners are removed on pointer-up. The final width
 * is persisted to localStorage so the next mount restores it.
 */
export function useDraggableWidth(options: DraggableWidthOptions) {
  const width = ref(options.defaultWidth)
  let resizeStart: { x: number; width: number } | null = null

  // 加载保存的面板宽度
  function loadWidth(): number {
    try {
      const saved = localStorage.getItem(options.storageKey)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (!isNaN(parsed) && parsed >= options.minWidth && parsed <= options.maxWidth) {
          return parsed
        }
      }
    } catch {}
    return options.defaultWidth
  }

  width.value = loadWidth()

  function startResize(e: PointerEvent) {
    resizeStart = { x: e.clientX, width: width.value }
    document.addEventListener('pointermove', onResize)
    document.addEventListener('pointerup', stopResize)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  function onResize(e: PointerEvent) {
    if (!resizeStart) return
    const delta = resizeStart.x - e.clientX
    const newWidth = Math.max(options.minWidth, Math.min(options.maxWidth, resizeStart.width + delta))
    width.value = newWidth
  }

  function stopResize() {
    resizeStart = null
    document.removeEventListener('pointermove', onResize)
    document.removeEventListener('pointerup', stopResize)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    try {
      localStorage.setItem(options.storageKey, String(width.value))
    } catch {}
  }

  const style = computed(() => ({
    width: `${width.value}px`,
  }))

  return { width, style, startResize }
}
