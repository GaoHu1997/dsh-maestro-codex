import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import css from '../src/client/board/upstream/client/tasks-graph.module.css'
import { JOBS_DOCK_ATTRIBUTE, JOBS_DOCK_CSS, JOBS_DOCK_SHARE, injectJobsDock } from '../src/client/board/jobs-dock.js'

const root = postcss.parse(JOBS_DOCK_CSS)

function declarations(selector: string): Record<string, string> {
  const values: Record<string, string> = {}
  root.walkRules(selector, rule => { rule.walkDecls(declaration => { values[declaration.prop] = declaration.value }) })
  return values
}

describe('jobs dock stylesheet', () => {
  it('pins the dock to the bottom at a fixed fifth of the board height', () => {
    const dock = declarations(`[${JOBS_DOCK_ATTRIBUTE}]`)
    expect(JOBS_DOCK_SHARE).toBe('20%')
    expect(dock.flex).toBe('0 0 20%')
    expect(dock['min-height']).toBe('28px')
    // 上方兄弟（`.subagentEmpty`、错误条等）不吸剩余空间，auto margin 把槽位钉在底部。
    expect(dock['margin-top']).toBe('auto')
    expect(dock.display).toBe('flex')
    expect(dock['flex-direction']).toBe('column')
    expect(dock.overflow).toBe('hidden')
  })

  it('lets the original drawer fill the dock and scroll inside it', () => {
    const section = declarations(`[${JOBS_DOCK_ATTRIBUTE}] > .${css.jobsDrawer}`)
    // 上游 `.jobsDrawer` 自带 `flex: none`，槽位规则靠更高特异性把它撑满。
    expect(section.flex).toBe('1 1 auto')
    expect(section['min-height']).toBe('0')
    expect(section['flex-direction']).toBe('column')
    expect(section.overflow).toBe('hidden')
    const body = declarations(`[${JOBS_DOCK_ATTRIBUTE}] > .${css.jobsDrawer} > .${css.jobsDrawerBody}`)
    // 取消上游 `max-height: 156px`，可视高度改由槽位决定。
    expect(body['max-height']).toBe('none')
    expect(body.flex).toBe('1 1 auto')
    expect(body['min-height']).toBe('0')
  })

  it('gives the slot back to the bar when the drawer is collapsed by hand', () => {
    const collapsed = declarations(
      `[${JOBS_DOCK_ATTRIBUTE}]:not(:has(> .${css.jobsDrawer} > .${css.jobsDrawerBody}))`,
    )
    expect(collapsed.flex).toBe('0 0 auto')
  })

  it('scopes every rule to the dock so the vendored drawer is untouched', () => {
    root.walkRules(rule => { expect(rule.selector).toContain(`[${JOBS_DOCK_ATTRIBUTE}]`) })
    expect(JOBS_DOCK_CSS).toContain(css.jobsDrawer)
    expect(JOBS_DOCK_CSS).toContain(css.jobsDrawerBody)
  })

  it('does nothing without a document', () => {
    expect(() => { injectJobsDock() }).not.toThrow()
  })
})
