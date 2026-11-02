// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { JOBS_DOCK_CSS, JOBS_DOCK_STYLE_ID, injectJobsDock } from '../src/client/board/jobs-dock.js'

describe('jobs dock injection', () => {
  it('injects the dock stylesheet exactly once', () => {
    injectJobsDock()
    injectJobsDock()
    const styles = document.head.querySelectorAll(`style#${JOBS_DOCK_STYLE_ID}`)
    expect(styles).toHaveLength(1)
    expect(styles[0]?.textContent).toBe(JOBS_DOCK_CSS)
  })

  it('refreshes a stale stylesheet instead of stacking a second one', () => {
    injectJobsDock()
    const style = document.getElementById(JOBS_DOCK_STYLE_ID)
    expect(style).not.toBeNull()
    style!.textContent = 'stale'
    injectJobsDock()
    expect(document.querySelectorAll(`style#${JOBS_DOCK_STYLE_ID}`)).toHaveLength(1)
    expect(document.getElementById(JOBS_DOCK_STYLE_ID)?.textContent).toBe(JOBS_DOCK_CSS)
  })
})
