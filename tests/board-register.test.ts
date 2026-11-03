import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { boardIcon, registerBoardTab, type BoardSidebarService } from '../src/client/board/register.js'
import { BOARD_TAB_ID, BOARD_TAB_TITLE } from '../src/client/board/Board.js'
import { cliSessionAddress, CLI_SESSION_KIND, CLI_SESSION_TAB_ID, parseCliSessionAddress, registerCliSessionTab, CliSessionTabBody } from '../src/client/board/session-tab.js'
import { en, zh } from '../src/client/board/upstream/index.js'
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
  /** sidebarRightTabs.register 的调用记录。 */
  readonly tabTypes: TabTypeRecord[]
  /** ctx.slots.inject 的调用记录。 */
  readonly slotInjections: [name: string, factory: () => unknown][]
}

/** sidebarRightTabs.register 收到的类型定义（测试侧的松散镜像）。 */
interface TabTypeRecord {
  id: string
  kind: string
  patterns?: readonly string[]
  canOpen?: (address: string) => boolean
  title: (address: string) => string
}

function harness(options: {
  sidebar?: BoardSidebarService | undefined
  register?: ((descriptor: Parameters<BoardSidebarService['registerTab']>[0]) => () => void) | undefined
  sidebarRightTabs?: { register(definition: TabTypeRecord): () => void } | undefined
} = {}): Harness {
  const callbacks: ((ctx: Injectee) => void)[] = []
  const cleanups: (() => void)[] = []
  let disposed = 0
  const sidebar: BoardSidebarService | undefined = 'sidebar' in options ? options.sidebar : {
    registerTab: options.register ?? (() => () => { disposed += 1 }),
  }
  const tabTypes: TabTypeRecord[] = []
  // 显式传 undefined = 服务缺席（与「没传这个选项」区分开）。
  const sidebarTabs = ('sidebarRightTabs' in options && options.sidebarRightTabs === undefined)
    ? undefined
    : options.sidebarRightTabs ?? {
        register: (definition: TabTypeRecord) => { tabTypes.push(definition); return () => {} },
      }
  const get = (name: string): unknown => (name === 'betterSidebar' ? sidebar : name === 'sidebarRightTabs' ? sidebarTabs : undefined)
  const slotInjections: [string, () => unknown][] = []
  const ctx = {
    inject: (_deps: string[], callback: (scope: Injectee) => void) => {
      callbacks.push(callback)
    },
    get,
    slots: {
      inject: (name: string, factory: () => unknown) => { slotInjections.push([name, factory]); return () => {} },
      register: (options: Record<string, unknown>, component: unknown) => ({ options, component }),
    },
  } as unknown as ClientContext
  const injectee: Injectee = {
    get,
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
    tabTypes,
    slotInjections,
  }
}

afterEach(() => { vi.restoreAllMocks() })

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
    // 两个注入：CLI 会话侧栏 tab（sidebarRightTabs 面）+ 看板 tab（better-sidebar）。
    expect(bed.injections()).toBe(2)
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

  it('overrides the transcript jump copy to session wording without touching vendored files', () => {
    const originalZh = zh.tasksNodeJump
    const originalEn = en.tasksNodeJump
    try {
      const bed = harness()
      registerBoardTab(bed.ctx)
      expect(zh.tasksNodeJump).toBe('查看会话')
      expect(en.tasksNodeJump).toBe('Open session')
    } finally {
      zh.tasksNodeJump = originalZh
      en.tasksNodeJump = originalEn
    }
  })
})

describe('cli session sidebar tab', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('round-trips the resource address with title, cli and scope', () => {
    const address = cliSessionAddress({ taskId: 'task/one', cli: 'codex', title: '修复登录页', sessionIds: ['a', 'b'] })
    expect(address.startsWith(`dsh-resource://${CLI_SESSION_KIND}/task/`)).toBe(true)
    expect(address).toContain(encodeURIComponent('task/one'))
    const parsed = parseCliSessionAddress(address)
    expect(parsed).toMatchObject({ taskId: 'task/one', cli: 'codex', title: '修复登录页', sessionIds: ['a', 'b'] })
    // 无可选事实的极简地址：taskId 之外全是 undefined。
    expect(parseCliSessionAddress(`dsh-resource://${CLI_SESSION_KIND}/task/t9`)).toMatchObject({ taskId: 't9' })
  })

  it('rejects addresses of other schemes and malformed paths', () => {
    expect(parseCliSessionAddress('dsh-resource://subagentchat/session/s1?parent=p&mode=one-shot')).toBeUndefined()
    expect(parseCliSessionAddress(`dsh-resource://${CLI_SESSION_KIND}/bogus/t1`)).toBeUndefined()
    expect(parseCliSessionAddress(`dsh-resource://${CLI_SESSION_KIND}/task/`)).toBeUndefined()
    expect(parseCliSessionAddress('not a url')).toBeUndefined()
  })

  it('registers the tab type and the keyed body under the same id', () => {
    const bed = harness()
    registerCliSessionTab(bed.ctx)
    expect(bed.injections()).toBe(1)
    bed.ready()
    expect(bed.tabTypes).toHaveLength(1)
    const definition = bed.tabTypes[0]
    expect(definition?.id).toBe(CLI_SESSION_TAB_ID)
    expect(definition?.kind).toBe(CLI_SESSION_KIND)
    expect(definition?.patterns).toEqual([`dsh-resource://${CLI_SESSION_KIND}/**`])
    expect(definition?.canOpen?.(cliSessionAddress({ taskId: 't1' }))).toBe(true)
    expect(definition?.canOpen?.('dsh-resource://file/session/s1/a.md')).toBe(false)
    expect(definition?.title(cliSessionAddress({ taskId: 't1', title: '修 bug' }))).toBe('修 bug')
    expect(definition?.title(`dsh-resource://${CLI_SESSION_KIND}/task/t1`)).toBe('CLI 会话')
    // 内容体挂在 pane.tab 键控槽，键 == 类型 id（宿主按 id 分发）。
    expect(bed.slotInjections).toEqual([['sidebar.right.pane.tab', expect.any(Function)]])
    const registered = bed.slotInjections[0]?.[1]()
    expect(registered).toMatchObject({ options: { name: 'sidebar.right.pane.tab', key: CLI_SESSION_TAB_ID } })
  })

  it('stays silent when the sidebar tab registry is absent', () => {
    const bed = harness({ sidebarRightTabs: undefined })
    registerCliSessionTab(bed.ctx)
    expect(() => { bed.ready() }).not.toThrow()
    expect(console.warn).not.toHaveBeenCalled()
    expect(bed.slotInjections).toHaveLength(0)
  })

  it('renders the session page for the addressed task and nothing for foreign addresses', () => {
    const bed = harness()
    registerCliSessionTab(bed.ctx)
    bed.ready()
    const body = bed.slotInjections[0]?.[1]()
    expect(body).toMatchObject({ component: CliSessionTabBody })
    const address = cliSessionAddress({ taskId: 'task-9', cli: 'claude', title: 'T' })
    const withHook = renderToStaticMarkup(createElement(CliSessionTabBody, { useTabInfo: () => ({ tab: { contentId: address } }) }))
    expect(withHook).toContain('role="alert"')
    expect(withHook).toContain('宿主尚未提供会话授权')
    const foreign = createElement(CliSessionTabBody, { useTabInfo: () => ({ tab: { contentId: 'dsh-resource://subagentchat/session/s1?parent=p&mode=one-shot' } }) })
    expect(renderToStaticMarkup(foreign)).toContain('无效的 CLI 子会话地址')
    expect(renderToStaticMarkup(createElement(CliSessionTabBody, {}))).toContain('缺少 CLI 子会话入口')
  })
})
