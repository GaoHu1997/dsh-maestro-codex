/** CLI-only content; native agents and jobs use their original upstream panes. */
import { useState, type ReactNode } from 'react'
import { Button, IconCodeOutlineRegular, IconRightUpOutlineRegular, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MaestroTaskSummary } from '../../wire.js'
import { taskCancellable, taskDuration, type BoardNode, type BoardTokenUsage } from './model.js'
import { interruptedStateLabel } from './copy.js'
import { formatJobDuration, t } from './upstream/index.js'
import { chatT } from './upstream/client/locales.js'
import { totalTokens } from './upstream/client/session-metrics.js'
import { formatTokens } from './upstream/client/sidechat-transcript.js'
import css from './upstream/client/tasks-graph.module.css'

/**
 * 与原生子代理详情（AgentNodePopover）同一套字段：状态 / Token 用量 / 耗时。
 * CLI 自己的模型、开始、结束、退出码和 CLI 标识都不进来——节点卡片上的
 * executor 徽标已经标识了 CLI，多出的字段正是「详情不一致」的来源。
 */
function phaseWord(phase: MaestroTaskSummary['phase']): string {
  switch (phase) {
    case 'queued': return '排队中'
    case 'running': return t('tasksStateRunning')
    case 'done': return t('tasksStateDone')
    case 'failed':
    case 'timeout': return t('tasksStateError')
    case 'cancelled': return '已取消'
    case 'interrupted': return interruptedStateLabel()
  }
}
function phaseDot(phase: MaestroTaskSummary['phase']): StateDotState {
  switch (phase) {
    case 'queued':
    case 'running': return 'ongoing'
    case 'done': return 'done'
    case 'failed':
    case 'timeout': return 'error'
    case 'cancelled':
    case 'interrupted': return 'idle'
  }
}
/** Token 行的悬停提示：宿主用量弹窗自己的四个桶（不可用就不加提示）。 */
function usageTip(usage: BoardTokenUsage): string | undefined {
  const buckets: [string | undefined, number][] = [
    [chatT('message.turnUsage.input'), usage.uncachedInputTokens],
    [chatT('message.turnUsage.cacheRead'), usage.cacheReadTokens],
    [chatT('message.turnUsage.cacheWrite'), usage.cacheWriteTokens],
    [chatT('message.turnUsage.output'), usage.outputTokens],
  ]
  const parts = buckets
    .filter(([label]) => label !== undefined)
    .map(([label, count]) => `${label ?? ''} ${formatTokens(count)}`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}
function CancelCli(props: { task: MaestroTaskSummary; onCancel: () => Promise<string | undefined> }): ReactNode {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  if (!taskCancellable(props.task)) return null
  return <>
    <Button variant="outline" size="sm" disabled={pending} onClick={() => {
      setPending(true)
      void props.onCancel().then(result => { setError(result); setPending(false) }, cause => {
        setError(cause instanceof Error ? cause.message : String(cause)); setPending(false)
      })
    }}>{pending ? '正在取消…' : '取消任务'}</Button>
    {error === undefined ? null : <span className={css.popHint} role="alert">{error}</span>}
  </>
}
export function CliNodePopover(props: {
  node: BoardNode; now: number; onCancel: () => Promise<string | undefined>;
  /** 打开这个 CLI 任务的会话页（气泡转录 + 续发消息，盖在看板之上）。 */
  onOpenSession: () => void
}): ReactNode {
  const task = props.node.task
  if (task === undefined) return null
  const usage = props.node.tokens
  const tip = usage === undefined ? undefined : usageTip(usage)
  return <div className={css.popCard} data-cli-detail={task.id}>
    <div className={css.popHead}><span>{t('tasksNodeDetail')}</span></div>
    <div className={css.popTitleRow}><span className={css.popGlyph}><IconCodeOutlineRegular size={14} /></span>
      <span className={css.popTitle} title={task.title}>{task.title}</span></div>
    {props.node.subtitle === undefined ? null : (
      <div className={css.popActivityBlock} data-node-activity>
        <span className={css.popHint} title={props.node.subtitle}>{props.node.subtitle}</span>
      </div>
    )}
    <dl className={css.popRows}>
      <span style={{ display: 'contents' }}>
        <dt className={css.popKey}>{t('tasksNodeState')}</dt>
        <dd className={css.popValue}><StateDot state={phaseDot(task.phase)} size={6} /> {phaseWord(task.phase)}</dd>
      </span>
      {usage === undefined ? null : <span style={{ display: 'contents' }}>
        <dt className={css.popKey}>{t('tasksNodeTokens')}</dt>
        <dd className={css.popValue} {...(tip === undefined ? {} : { title: tip })}>{formatTokens(totalTokens(usage))}</dd>
      </span>}
      <span style={{ display: 'contents' }}>
        <dt className={css.popKey}>{t('tasksNodeDuration')}</dt>
        <dd className={css.popValue}>{formatJobDuration(taskDuration(task, props.now), t)}</dd>
      </span>
    </dl>
    {task.truncated === true ? <span className={css.popHint}>较早输出已截断</span> : null}
    {/* 与原生子代理详情同一个动作行（popFoot：hairline 之上，主按钮撑满
      整行）；此处曾写错成不存在的 popActions，按钮就缩成自然宽度了。 */}
    <div className={css.popFoot}>
      {/* 「查看会话」与 dsh 子代理同一条侧边通道：进右栏的 CLI 会话 tab
        （气泡转录 + Markdown + 续发输入框，见 session-tab.tsx）；宿主没有
        那个面时 Board 才回落面板内覆盖层。原始日志同页可见（note/error/
        最终结果都有），不再单设「查看转录」窗。按钮图标与 dsh 跳转一致
        （↗ 右上箭头 = 在侧边另开）。 */}
      <Button variant="primary" size="sm" icon={<IconRightUpOutlineRegular size={12} />} onClick={props.onOpenSession}>{t('tasksNodeJump')}</Button>
      <CancelCli task={task} onCancel={props.onCancel} />
    </div>
  </div>
}
