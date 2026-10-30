/** CLI-only content; native agents and jobs use their original upstream panes. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCodeOutlineRegular, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { CLI_LABELS, cleanLogText, type MaestroTaskEvent, type MaestroTaskSummary } from '../../wire.js'
import { type BoardCliDetailState } from './data.js'
import { formatClock, formatDuration, taskCancellable, taskDuration, tokenSummary, type BoardNode } from './model.js'
import { FloatingWindow } from './upstream/index.js'
import css from './upstream/client/tasks-graph.module.css'

const PHASE_LABELS: Record<MaestroTaskSummary['phase'], string> = {
  queued: '排队中', running: '运行中', done: '已完成', failed: '失败', timeout: '超时', cancelled: '已取消',
}
function CliFacts(props: { node: BoardNode; now: number }): ReactNode {
  const task = props.node.task
  if (task === undefined) return null
  const facts = [
    ['状态', PHASE_LABELS[task.phase]], ['CLI', CLI_LABELS[task.cli]],
    ['模型', task.model === '' ? '默认模型' : task.model], ['开始', formatClock(task.startedAt)],
    ['耗时', formatDuration(taskDuration(task, props.now))],
    ...(task.endedAt === undefined ? [] : [['结束', formatClock(task.endedAt)]]),
    ...(task.exitCode === undefined ? [] : [['退出码', String(task.exitCode)]]),
    ['Token 用量', tokenSummary(props.node.tokens) ?? (task.usage !== undefined ? '0 tok' : taskCancellable(task) ? '尚未收到用量' : '未采集（不代表零消耗）')],
  ]
  return <dl className={css.popRows}>{facts.map(([label, value]) => <span key={label} style={{ display: 'contents' }}>
    <dt className={css.popKey}>{label}</dt><dd className={css.popValue} title={value}>{value}</dd>
  </span>)}</dl>
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
  node: BoardNode; now: number; onOutput: () => void; onCancel: () => Promise<string | undefined>
}): ReactNode {
  const task = props.node.task
  if (task === undefined) return null
  return <div className={css.popCard} data-cli-detail={task.id}>
    <div className={css.popHead}><span>CLI 子代理详情</span><Tag tone="quiet">{CLI_LABELS[task.cli]}</Tag></div>
    <div className={css.popTitleRow}><span className={css.popGlyph}><IconCodeOutlineRegular size={14} /></span>
      <span className={css.popTitle} title={task.title}>{task.title}</span></div>
    <CliFacts node={props.node} now={props.now} />
    {task.truncated === true ? <span className={css.popHint}>较早输出已截断</span> : null}
    <div className={css.popActions}>
      <Button variant="primary" size="sm" onClick={props.onOutput}>查看转录</Button>
      <CancelCli task={task} onCancel={props.onCancel} />
    </div>
  </div>
}
/** Consecutive chunks are messages, but phase/error/result boundaries stay intact. */
export function cliTranscriptItems(events: readonly MaestroTaskEvent[]): MaestroTaskEvent[] {
  const items: MaestroTaskEvent[] = []
  for (const event of events) {
    const text = cleanLogText(event.text)
    if (text === '') continue
    const previous = items.at(-1)
    if (previous !== undefined && previous.kind === event.kind && (event.kind === 'text' || event.kind === 'note')) {
      items[items.length - 1] = { ...previous, text: `${previous.text}\n${text}` }
    } else items.push({ ...event, text })
  }
  return items
}
export function CliOutputWindow(props: {
  node: BoardNode; now: number; detail: BoardCliDetailState; anchor: HTMLElement;
  onClose: () => void; onCancel: () => Promise<string | undefined>
}): ReactNode {
  const task = props.detail.summary ?? props.node.task
  const bodyRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const events = cliTranscriptItems(props.detail.events)
  const lastSeq = props.detail.events.at(-1)?.seq
  useEffect(() => {
    if (follow && bodyRef.current !== null) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [follow, lastSeq, props.detail.finalText])
  if (task === undefined) return null
  return <FloatingWindow title={`转录 · ${CLI_LABELS[task.cli]} · ${task.title}`} anchor={props.anchor}
    onClose={props.onClose} bodyRef={bodyRef}
    footer={<><Switch checked={follow} onChange={setFollow} label="跟随最新输出" />
      <CancelCli task={task} onCancel={props.onCancel} /></>}>
    <CliFacts node={{ ...props.node, task }} now={props.now} />
    {props.detail.cwd === undefined ? null : <dl className={css.popRows}>
      <dt className={css.popKey}>工作目录</dt><dd className={css.popValue} title={props.detail.cwd}>{props.detail.cwd}</dd>
    </dl>}
    {props.detail.error === undefined ? null : <p className={css.popHint} role="alert">{props.detail.error}</p>}
    {props.detail.failure === undefined ? null : <p className={css.popHint} role="alert">{props.detail.failure}</p>}
    {task.truncated === true ? <p className={css.popHint}>较早输出已截断</p> : null}
    {events.length === 0 && !props.detail.finalText ? <p className={css.popHint}>{taskCancellable(task) ? '等待 CLI 输出…' : '没有输出'}</p> : null}
    {events.map(event => <div className={css.popSection} key={event.seq} data-cli-event={event.kind}>
      <div className={css.popGroup}>{event.kind === 'result' ? '最终结果' : event.kind === 'error' ? '错误' : PHASE_LABELS[task.phase]} · {formatClock(event.at)}</div>
      <pre className={css.popHint} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{event.text}</pre>
    </div>)}
    {props.detail.finalText && !events.some(event => event.kind === 'result' && event.text === props.detail.finalText) ? <div className={css.popSection} data-cli-final-result>
      <div className={css.popGroup}>最终结果</div>
      <pre className={css.popHint} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{cleanLogText(props.detail.finalText)}</pre>
    </div> : null}
    {taskCancellable(task) ? <StateDot state="ongoing" size={6} /> : null}
  </FloatingWindow>
}
