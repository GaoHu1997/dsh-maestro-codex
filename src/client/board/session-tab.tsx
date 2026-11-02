/**
 * CLI 子代理会话的**侧栏 tab**：让「查看会话」与 dsh 子代理走同一条路——
 * 宿主右栏（`sidebarRight.openResource`）里打开一个会话页，而不是盖在看板上。
 *
 * 宿主右栏的 tab 类型是公开的两段式注册（`dsh-client-ui-sidebar-right`，
 * `subagentchat` 自己就这么注册）：
 *
 * 1. `ctx.sidebarRightTabs.register(definition)`——类型静态面：id / kind /
 *    地址通配（`patterns`）/ tab chip 标题（`title(address)`，打开时捕获）。
 * 2. `ctx.slots.inject('sidebar.right.pane.tab', ...)`——按 definition 的 id
 *    键控注册内容体；框架把 `useTabInfo`（tab 记录、地址、导航）注入 props。
 *
 * 地址自成一格：`dsh-resource://maestro-cli-chat/task/<taskId>` + 查询串。
 * CLI 会话没有本地 DSH 会话可借（subagentchat 需要真实的 SessionReference），
 * 但地址机制是内容无关的——我们的类型声明认领这个 scheme，内容体自己解析
 * taskId 后渲染会话页（Session 的轮询与续发都在插件自己的 HTTP 面上）。
 *
 * @module dsh-maestro-codex/client/board/session-tab
 */

import { useActiveCliAccess } from '../access.js'
import { type ReactNode } from 'react'
import type { MaestroCliId } from '../../wire.js'
import type { ClientContext } from '../types.js'
import { SessionPage } from './Session.js'

/** tab kind：`openResource` 的 options.kind 与注册类型一致。 */
export const CLI_SESSION_KIND = 'maestro-cli-chat'

/** 内容体在 `sidebar.right.pane.tab` 键控槽里的键 == 注册类型的 id。 */
export const CLI_SESSION_TAB_ID = 'dsh-maestro-codex/cli-session'

/** 会话页查询串里携带的打开时事实（标题给 chip、cli/scope 给内容体）。 */
interface CliSessionTarget {
  readonly taskId: string
  readonly cli?: string
  readonly title?: string
  readonly sessionIds?: readonly string[]
}

/** 拼一个 CLI 会话的资源地址（看板跳转与 tab 还原共用）。 */
export function cliSessionAddress(target: CliSessionTarget): string {
  const query = new URLSearchParams()
  if (target.cli !== undefined && target.cli !== '') query.set('cli', target.cli)
  if (target.title !== undefined && target.title !== '') query.set('title', target.title)
  const scope = target.sessionIds?.filter(id => id !== '').join(',') ?? ''
  if (scope !== '') query.set('scope', scope)
  const search = query.toString()
  return `dsh-resource://${CLI_SESSION_KIND}/task/${encodeURIComponent(target.taskId)}${search === '' ? '' : `?${search}`}`
}

/** 解析一个 CLI 会话资源地址（畸形/别的 scheme 一律 undefined）。 */
export function parseCliSessionAddress(value: string): CliSessionTarget | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== CLI_SESSION_KIND) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'task') return undefined
  let taskId: string
  try {
    taskId = decodeURIComponent(parts[1] ?? '')
  } catch {
    return undefined
  }
  if (taskId === '') return undefined
  const title = url.searchParams.get('title') ?? undefined
  const cli = url.searchParams.get('cli') ?? undefined
  const scope = url.searchParams.get('scope') ?? ''
  const sessionIds = scope === '' ? undefined : scope.split(',').filter(id => id !== '')
  return {
    taskId,
    ...(cli === undefined ? {} : { cli }),
    ...(title === undefined ? {} : { title }),
    ...(sessionIds === undefined ? {} : { sessionIds }),
  }
}

/** `ctx.sidebarRightTabs` 的结构化镜像（宿主包不跨包可 import）。 */
export interface SidebarRightTabsService {
  register(definition: {
    id: string
    kind: string
    /** 地址通配；含 `:` 的 pattern 对整个地址匹配。 */
    patterns?: readonly string[]
    canOpen?: (address: string) => boolean
    /** tab chip 的初始标题（打开时捕获；每语言重读，thunked）。 */
    title: (address: string) => string
  }): () => void
  get?(kind: string): unknown
}

/** 内容体拿到的框架注入（`sidebar.right.pane.tab` 槽的 hooks 面）。 */
interface TabInfoLike {
  readonly tab: {
    readonly contentId: string
    readonly navigation?: { readonly address?: string } | undefined
  }
}

/** CLI 会话 tab 的内容体：解析地址 → 渲染会话页（撑满 tab 座位）。 */
export function CliSessionTabBody(props: { useTabInfo?: () => TabInfoLike }): ReactNode {
  // 框架注入的 hook；宿主改了注入面时宁可空态也不把整个右栏拖下水。
  const useTabInfo = props.useTabInfo
  const access = useActiveCliAccess()
  if (typeof useTabInfo !== 'function') return <div role="alert">当前宿主缺少 CLI 子会话入口；请从当前父会话看板打开。</div>
  const info = useTabInfo()
  const address = info?.tab.navigation?.address ?? info?.tab.contentId
  const target = address === undefined ? undefined : parseCliSessionAddress(address)
  if (target === undefined) return <div role="alert">无效的 CLI 子会话地址。</div>
  if (access === undefined || (target.sessionIds !== undefined && !target.sessionIds.includes(access.sessionId))) return <div role="alert">这个 CLI 子会话不属于当前父会话，或宿主尚未提供会话授权。请回到所属父会话后重新打开。</div>
  return <SessionPage
    access={access}
    taskId={target.taskId}
    {...(target.cli === undefined ? {} : { cli: target.cli as MaestroCliId })}
    place="tab"
    {...(target.sessionIds === undefined ? {} : { sessionIds: target.sessionIds })}
  />
}

/**
 * 注册 CLI 会话 tab（类型 + 内容体）。`sidebarRightTabs` 缺席（宿主没有右栏
 * 包）时什么都不做——看板按钮会回落到面板内覆盖层。
 *
 * @param ctx - 客户端根上下文。
 */
export function registerCliSessionTab(ctx: ClientContext): void {
  ctx.inject(['sidebarRightTabs'], (injected) => {
    const tabs = injected.get('sidebarRightTabs') as SidebarRightTabsService | undefined
    // 没有注册面就没有认领地址的窗口，内容体也不必挂（没有该 kind 的 tab 会
    // 被分发到它）。
    if (tabs === undefined || typeof tabs.register !== 'function') return
    let disposeType: (() => void) | undefined
    try {
      disposeType = tabs.register({
        id: CLI_SESSION_TAB_ID,
        kind: CLI_SESSION_KIND,
        patterns: [`dsh-resource://${CLI_SESSION_KIND}/**`],
        canOpen: address => parseCliSessionAddress(address) !== undefined,
        // chip 标题 = 打开时点中的任务名（看板放进地址查询串）；查询串丢失
        // （undo 恢复等）就退回通用名。
        title: address => parseCliSessionAddress(address)?.title ?? 'CLI 会话',
      })
    } catch (cause) {
      // 重复注册（热重载两次 apply）不该拖垮客户端。
      console.warn('[dsh-maestro-codex] CLI 会话 tab 注册失败：', cause)
      return
    }
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: CLI_SESSION_TAB_ID,
    }, CliSessionTabBody))
    injected.effect(() => () => {
      disposeBody?.()
      disposeType?.()
    }, 'maestro-codex: CLI 会话侧栏 tab')
  })
}
