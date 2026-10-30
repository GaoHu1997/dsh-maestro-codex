import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFrameBatcher, easeOut, fitTransform, GLIDE_MS, layoutTasksGraphForWidth,
  lerpTransform, TWEEN_MS, tweenBox, type TasksNode,
} from '../src/client/board/upstream/index.js'

const fixture = JSON.parse(readFileSync(new URL('./upstream-fixtures/layout-golden.json', import.meta.url), 'utf8')) as {
  cases: { name: string; width: number; nodes: TasksNode[]; expected: { boxes: unknown[]; width: number; height: number } }[]
}

afterEach(() => { vi.unstubAllGlobals() })

describe('original graph geometry and motion', () => {
  for (const test of fixture.cases) it(`matches upstream coordinates: ${test.name}`, () => {
    const layout = layoutTasksGraphForWidth(test.nodes, test.width)
    expect({ boxes: [...layout.boxes.values()], width: layout.width, height: layout.height }).toEqual(test.expected)
  })

  it('keeps the original fit floor, content centering and 220ms animation cadence', () => {
    expect(TWEEN_MS).toBe(220)
    expect(GLIDE_MS).toBe(220)
    expect(easeOut(0.5)).toBe(0.875)
    const fit = fitTransform({
      containerW: 360, containerH: 480, layoutW: 222, layoutH: 119,
      pad: 16, minContentW: 190, minContentH: 87, margin: 24,
      minScale: 0.78, maxScale: 1.3,
    })
    expect(fit?.x).toBeCloseTo(35.7)
    expect(fit?.y).toBeCloseTo(162.65)
    expect(fit?.k).toBe(1.3)
    expect(lerpTransform({ x: 0, y: 10, k: 1 }, { x: 20, y: 30, k: 2 }, 0.5)).toEqual({ x: 10, y: 20, k: 1.5 })
    expect(tweenBox({ x: 0, y: 0, w: 190, h: 87 }, { id: 'a', x: 100, y: 80, w: 190, h: 100 }, 0.5)).toEqual({ id: 'a', x: 50, y: 40, w: 190, h: 93.5 })
  })

  it('coalesces pointer updates and flushes the final position on release', () => {
    let frame: (() => void) | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: () => void) => { frame = callback; return 7 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const batcher = createFrameBatcher()
    const first = vi.fn(), last = vi.fn()
    batcher.schedule(first)
    batcher.schedule(last)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    frame?.()
    expect(first).not.toHaveBeenCalled()
    expect(last).toHaveBeenCalledOnce()
    batcher.schedule(first)
    batcher.flushNow()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7)
    expect(first).toHaveBeenCalledOnce()
    batcher.schedule(last)
    batcher.dispose()
    expect(last).toHaveBeenCalledOnce()
  })
})
