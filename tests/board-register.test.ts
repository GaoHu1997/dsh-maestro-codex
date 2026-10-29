import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { boardIcon, registerBoardTab, type BoardSidebarService } from '../src/client/board/register.js'
import { BOARD_TAB_ID, BOARD_TAB_TITLE } from '../src/client/board/Board.js'
import type { ClientContext } from '../src/client/types.js'

interface Injectee {
  get(name: string): unknown
  effect(body: () => () => void, label?: string): void
}

interface Harness {
  readonly ctx: ClientContext
  /** 注入回调是否真的被注册（better-sidebar 缺席时也该注册，只是什么都不做）。 */
  injections(): number
  /** 跑一遍 `inject` 回调（模拟服务就绪）。 */
  ready(): void
  /** 跑注入体注册的清理函数（模拟插件卸载/热重载）。 */
  cleanup(): void
  disposals(): number
}

function harness(options: {
  sidebar?: BoardSidebarService | undefined
  register?: ((descriptor: Parameters<BoardSidebarService['registerTab']>[0]) => () => void) | undefined
} = {}): Harness {
  const callbacks: ((ctx: Injectee) => void)[] = []
  const cleanups: (() => void)[] = []
  let disposed = 0
  const sidebar: BoardSidebarService | undefined = options.sidebar ?? {
    registerTab: options.register ?? (() => () => { disposed += 1 }),
  }
  const ctx = {
    inject: (_deps: string[], callback: (scope: Injectee) => void) => {
      callbacks.push(callback)
    },
    get: (name: string) => (name === 'betterSidebar' ? sidebar : undefined),
  } as unknown as ClientContext
  const injectee: Injectee = {
    get: name => (name === 'betterSidebar' ? sidebar : undefined),
    effect: body => {
      cleanups.push(body())
    },
  }
  return {
    ctx,
    injections: () => callbacks.length,
    ready: () => {
      for (const callback of callbacks) callback(injectee)
    },
    cleanup: () => {
      for (const drain of cleanups) drain()
    },
    disposals: () => disposed,
  }
}

describe('boardIcon', () => {
  it.each([16, 24])('renders a two-tone theme-aware checklist at size %i', size => {
    const html = renderToStaticMarkup(boardIcon(size))
    expect(html).toContain(`width="${size}"`)
    expect(html).toContain(`height="${size}"`)
    expect(html).toContain('light-dark(#2563eb, #7aa2ff)')
    expect(html.match(/light-dark\(#15803d, #4ade80\)/g)).toHaveLength(2)
    expect(html).not.toContain('currentColor')
    expect(html).toContain('aria-hidden="true"')
  })
})

describe('registerBoardTab', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('registers one single-instance tab component', () => {
    const calls: Parameters<BoardSidebarService['registerTab']>[0][] = []
    const bed = harness({ register: descriptor => { calls.push(descriptor); return () => {} } })
    registerBoardTab(bed.ctx)
    expect(bed.injections()).toBe(1)
    bed.ready()
    expect(calls).toHaveLength(1)
    const descriptor = calls[0]
    expect(descriptor).toMatchObject({ id: BOARD_TAB_ID, title: BOARD_TAB_TITLE, single: true })
    expect(typeof descriptor?.component).toBe('function')
    expect(typeof descriptor?.icon).toBe('function')
  })

  it('passes the caller scope and visibility straight through to the component', () => {
    const calls: Parameters<BoardSidebarService['registerTab']>[0][] = []
    const bed = harness({ register: descriptor => { calls.push(descriptor); return () => {} } })
    registerBoardTab(bed.ctx)
    bed.ready()
    const element = calls[0]?.component({ ctx: bed.ctx, scope: { sessionId: 's1', cwd: '/work' }, visible: false })
    expect(element).toMatchObject({ props: { scope: { sessionId: 's1', cwd: '/work' }, visible: false } })
  })

  it('releases the tab when the injecting fiber is disposed', () => {
    let released = 0
    const bed = harness({ register: () => () => { released += 1 } })
    registerBoardTab(bed.ctx)
    bed.ready()
    expect(released).toBe(0)
    bed.cleanup()
    expect(released).toBe(1)
  })

  it('stays silent when better-sidebar is not installed', () => {
    const bed = harness({ sidebar: undefined })
    registerBoardTab(bed.ctx)
    expect(() => { bed.ready() }).not.toThrow()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('survives a duplicate-id rejection from the sidebar service', () => {
    const bed = harness({
      register: () => { throw new Error('[dsh-better-sidebar] tab type "maestro-board" already registered') },
    })
    registerBoardTab(bed.ctx)
    expect(() => { bed.ready() }).not.toThrow()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(() => { bed.cleanup() }).not.toThrow()
  })
})
