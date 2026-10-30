/**
 * 把「任务看板」注册进右侧栏。
 *
 * 座位是 better-sidebar 的 `registerTab`：它内部再把 tab 注册进 DSH 原生右侧栏
 * 的 `sidebarRightTabs` 与 `sidebar.right.pane.tab` 插槽，所以这里只要给出
 * 描述符与组件即可，不需要自己碰插槽。
 *
 * `betterSidebar` 是**可选**服务（用户没装那个插件就没有），因此不写进本插件
 * 的 `inject` 声明（那会让整个客户端 half 加载不了），而是用 `ctx.inject`
 * 等它出现——服务缺失时这段什么都不做。
 *
 * @module dsh-maestro-codex/client/board/register
 */

import { createElement, type ReactNode } from 'react'

import type { ClientContext } from '../types.js'
import { BOARD_TAB_ID, BOARD_TAB_TITLE, BoardTab, type BoardTabProps } from './Board.js'

/** better-sidebar 交给 tab 组件的属性（本面板只声明自己用到的）。 */
export interface BoardTabInput {
  readonly ctx: BoardTabProps['ctx']
  readonly scope: { readonly sessionId: string; readonly cwd?: string }
  readonly visible?: boolean
  readonly store?: BoardTabProps['store']
}

/** `ctx.betterSidebar` 的结构化镜像（宿主包不跨包可 import）。 */
export interface BoardSidebarService {
  registerTab(descriptor: {
    id: string
    title: string
    description?: string
    icon?: (size: number) => ReactNode
    order?: number
    single?: boolean
    component: (props: BoardTabInput) => ReactNode
  }): () => void
}

/** tab 图标：绿色对勾 + 蓝色清单，独立于侧栏选中/悬停文字颜色并适配主题。 */
export function boardIcon(size: number): ReactNode {
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    style: { stroke: 'light-dark(#2563eb, #7aa2ff)' },
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }, [
    createElement('path', { key: 'check-1', d: 'M2.6 4.6l1.2 1.2 2.3-2.3', style: { stroke: 'light-dark(#15803d, #4ade80)' } }),
    createElement('path', { key: 'check-2', d: 'M2.6 11.2l1.2 1.2 2.3-2.3', style: { stroke: 'light-dark(#15803d, #4ade80)' } }),
    createElement('path', { key: 'row-1', d: 'M8.6 4.7H14' }),
    createElement('path', { key: 'row-2', d: 'M8.6 11.3H14' }),
  ])
}

/**
 * 注册看板 tab（better-sidebar 缺席时静默跳过）。
 * @param ctx - 客户端根上下文。
 */
export function registerBoardTab(ctx: ClientContext): void {
  ctx.inject(['betterSidebar'], (injected) => {
    const sidebar = injected.get('betterSidebar') as BoardSidebarService | undefined
    if (sidebar === undefined || typeof sidebar.registerTab !== 'function') return
    let dispose: (() => void) | undefined
    try {
      dispose = sidebar.registerTab({
        id: BOARD_TAB_ID,
        title: BOARD_TAB_TITLE,
        description: 'DSH 主任务与子代理、CLI 子代理、后台任务集中在一页',
        icon: boardIcon,
        order: 45,
        single: true,
        component: (input: BoardTabInput) => createElement(BoardTab, {
          ctx: input.ctx,
          scope: input.scope,
          visible: input.visible !== false,
          ...(input.store === undefined ? {} : { store: input.store }),
        }),
      })
    } catch (cause) {
      // 重复 id（热重载两次 apply）不该把整个客户端拖下水：记一条日志即可。
      console.warn('[dsh-maestro-codex] 任务看板 tab 注册失败：', cause)
      dispose = undefined
    }
    if (dispose === undefined) return
    injected.effect(() => () => { dispose?.() }, 'maestro-codex: 任务看板 tab')
  })
}
