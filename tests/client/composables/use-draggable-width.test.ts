// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useDraggableWidth } from '@/composables/useDraggableWidth'

describe('useDraggableWidth', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function pointerEvent(clientX: number): PointerEvent {
    return { clientX } as unknown as PointerEvent
  }

  it('returns the default width when nothing is stored', () => {
    const { width } = useDraggableWidth({ storageKey: 'k', minWidth: 280, maxWidth: 600, defaultWidth: 360 })
    expect(width.value).toBe(360)
  })

  it('restores a stored width within bounds', () => {
    localStorage.setItem('k', '420')
    const { width } = useDraggableWidth({ storageKey: 'k', minWidth: 280, maxWidth: 600, defaultWidth: 360 })
    expect(width.value).toBe(420)
  })

  it('falls back to the default for out-of-range or corrupt stored values', () => {
    localStorage.setItem('k', '100')
    expect(useDraggableWidth({ storageKey: 'k', minWidth: 280, maxWidth: 600, defaultWidth: 360 }).width.value).toBe(360)

    localStorage.setItem('k', 'not-a-number')
    expect(useDraggableWidth({ storageKey: 'k', minWidth: 280, maxWidth: 600, defaultWidth: 360 }).width.value).toBe(360)
  })

  it('clamps the width while dragging and persists it on stop', () => {
    const { width, startResize } = useDraggableWidth({ storageKey: 'k', minWidth: 280, maxWidth: 600, defaultWidth: 360 })

    // Drag left by 200px → widen to 560
    startResize(pointerEvent(500))
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 }))
    expect(width.value).toBe(560)

    // Drag beyond the max → clamped
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: -100 }))
    expect(width.value).toBe(600)

    document.dispatchEvent(new PointerEvent('pointerup'))
    expect(localStorage.getItem('k')).toBe('600')
  })

  it('stops tracking after pointer-up (no further moves applied)', () => {
    const { width, startResize } = useDraggableWidth({ storageKey: 'k', minWidth: 280, maxWidth: 600, defaultWidth: 360 })

    startResize(pointerEvent(400))
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 350 }))
    document.dispatchEvent(new PointerEvent('pointerup'))
    const persisted = width.value
    expect(persisted).toBe(410)

    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 }))
    expect(width.value).toBe(persisted)
  })

  it('removes document listeners on pointer-up (no duplicate handlers after re-drag)', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { startResize } = useDraggableWidth({ storageKey: 'k', minWidth: 280, maxWidth: 600, defaultWidth: 360 })

    startResize(pointerEvent(400))
    document.dispatchEvent(new PointerEvent('pointerup'))
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
    removeSpy.mockRestore()
  })
})
