import { describe, expect, it } from 'vitest'
import { mergeTaskDetail } from '../src/client/MaestroCard.js'
import type { MaestroTaskDetail, MaestroTaskEvent, MaestroTaskSummary } from '../src/wire.js'

function summary(phase: MaestroTaskSummary['phase']): MaestroTaskSummary {
  return { id: 'task-1', cli: 'codex', title: '任务', phase, model: '', startedAt: 1 }
}

function detail(phase: MaestroTaskSummary['phase'], events: readonly MaestroTaskEvent[]): MaestroTaskDetail {
  return { summary: summary(phase), events, nextCursor: events.at(-1)?.seq ?? 0 }
}

const event = (seq: number, text: string): MaestroTaskEvent => ({ seq, at: 1, kind: 'note', text })

describe('mergeTaskDetail', () => {
  it('starts from the first fetched page', () => {
    const first = detail('running', [event(1, '开始'), event(2, '输出')])
    expect(mergeTaskDetail(undefined, first)).toBe(first)
  })

  it('appends polled pages while the phase is unchanged', () => {
    const accumulated = mergeTaskDetail(
      detail('running', [event(1, '开始')]),
      detail('running', [event(2, '输出')]),
    )
    expect(accumulated.events.map(entry => entry.text)).toEqual(['开始', '输出'])
    expect(accumulated.summary.phase).toBe('running')
  })

  it('keeps the accumulated transcript across a phase change (completion must not wipe the log)', () => {
    let view = detail('running', [event(1, '开始'), event(2, '命令完成')])
    view = mergeTaskDetail(view, detail('done', [event(3, '执行完成')]))
    expect(view.summary.phase).toBe('done')
    expect(view.events.map(entry => entry.text)).toEqual(['开始', '命令完成', '执行完成'])
  })

  it('bounds the accumulated events to the newest 400', () => {
    let view = detail('running', Array.from({ length: 380 }, (_, index) => event(index + 1, `行 ${String(index)}`)))
    view = mergeTaskDetail(view, detail('done', Array.from({ length: 60 }, (_, index) => event(381 + index, `尾 ${String(index)}`))))
    expect(view.events).toHaveLength(400)
    expect(view.events[0]?.text).toBe('行 40')
    expect(view.events.at(-1)?.text).toBe('尾 59')
  })
})
