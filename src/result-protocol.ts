/**
 * 结构化收尾协议：任务在最后一行声明"我现在是什么状态、需要人做什么"。
 *
 * 为什么不让模型用自然语言说"我卡住了"：那句话要被人读、被程序判断，两种用途
 * 都不可靠。dsh-superagent 的 `docs/001` 明确拒绝"从报告自由文本推断等待人"，
 * 这里沿用同一条：**只认显式的一行 JSON，读不到就退成 unknown，绝不猜**。
 *
 * 协议行（子代理的最后一行）：
 *   MAESTRO_RESULT {"state":"ready","summary":"改完三处"}
 *   MAESTRO_RESULT {"state":"blocked","human_action":"确认线上库能否直连"}
 *
 * 解析是宽松的（前后可以有空白、日志可以有几千行），校验是严格的（state 必须
 * 是枚举之一，JSON 必须能解析）——坏行等于没有行。
 */

import type { MaestroResultState, MaestroTaskResult } from './wire.js'
import { RESULT_STATES } from './stage.js'

/** 协议行的标记，行首（可有空白）出现才算。 */
export const RESULT_MARKER = 'MAESTRO_RESULT'

/** 只回扫末尾这么多行：协议行要求在最后，翻遍长日志既慢又容易撞上示例文本。 */
export const RESULT_SCAN_LINES = 40

/** 字段长度上限：这是"一句话"，不是报告。 */
export const RESULT_SUMMARY_CAP = 500
export const RESULT_ACTION_CAP = 200

/** 注入到任务文本末尾的说明（保持一行，避免改变模型的输出结构）。 */
export const RESULT_PROTOCOL_LINE = `${RESULT_MARKER} {"state":"progress|waiting|ready|blocked|failed|dropped","human_action":"只有人能做的下一步（state=waiting/blocked 时填写）","summary":"一句话结论"}`

/**
 * 从最终文本里解析协议行。
 *
 * @returns 解析成功的结果；没有协议行或行不合法 = `undefined`（调用方退成
 * `fallbackResult`，而不是把垃圾当结论）。
 */
export function parseResultLine(finalText: string | undefined): MaestroTaskResult | undefined {
  if (finalText === undefined || finalText === '') return undefined
  const lines = finalText.split(/\r?\n/)
  const tail = lines.slice(Math.max(0, lines.length - RESULT_SCAN_LINES))
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = (tail[index] ?? '').trim()
    if (!line.startsWith(RESULT_MARKER)) continue
    const payload = line.slice(RESULT_MARKER.length).trim()
    if (payload === '') continue
    const parsed = payloadOf(payload)
    if (parsed !== undefined) return parsed
    // 标记在了但内容坏了：继续往前找（可能前面还有一条完好的），都坏就返回
    // undefined，让上层退成 unknown。
  }
  return undefined
}

function payloadOf(payload: string): MaestroTaskResult | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as { state?: unknown; human_action?: unknown; summary?: unknown }
  const state = record.state
  if (typeof state !== 'string' || !(RESULT_STATES as readonly string[]).includes(state)) return undefined
  const action = typeof record.human_action === 'string' ? clip(record.human_action, RESULT_ACTION_CAP) : undefined
  const summary = typeof record.summary === 'string' ? clip(record.summary, RESULT_SUMMARY_CAP) : undefined
  return {
    state: state as MaestroResultState,
    ...(action === undefined || action === '' ? {} : { humanAction: action }),
    ...(summary === undefined || summary === '' ? {} : { summary }),
    source: 'protocol',
  }
}

function clip(text: string, cap: number): string {
  // 压平换行：一个字段一行，避免详情页把一句话渲染成多段。
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat
}
