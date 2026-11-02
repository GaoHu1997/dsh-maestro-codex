/**
 * 从 phase 和结构化收尾派生"现在该谁动"。
 *
 * 规则只有一条：**stage 由已经写下的字段推出来，不读自由文本**。一个人要知道
 * "这张卡在等我吗"，答案必须能从 (phase, result) 唯一算出，否则看板每格都得
 * 靠人自己读一遍日志。
 *
 * 优先级：结构化收尾里明确写了人要做的事 → 听它的；没写 → 按 phase 推。
 * `interrupted` 单独处理：进程没了，能不能重跑只有人能定。
 */

import type { MaestroPhase, MaestroResultState, MaestroStage, MaestroTaskResult } from './wire.js'

/** 允许出现在协议行里的 state。 */
export const RESULT_STATES: readonly MaestroResultState[] = [
  'progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'unknown',
]

/**
 * 没有协议行时的收尾推导。
 *
 * `done` 推成 `ready` 而不是 `unknown`：本插件没有任何自动消费结果的机制，
 * 跑完的结果一定停在某人眼前，说"等你验收"是准确的。
 */
export function fallbackResult(phase: MaestroPhase): MaestroTaskResult {
  switch (phase) {
    case 'done': return { state: 'ready', source: 'fallback' }
    case 'failed': return { state: 'failed', source: 'fallback' }
    case 'timeout': return { state: 'failed', source: 'fallback' }
    case 'cancelled': return { state: 'dropped', source: 'fallback' }
    case 'interrupted': return { state: 'waiting', humanAction: '决定是否重新派发', source: 'fallback' }
    case 'queued':
    case 'running':
      return { state: 'progress', source: 'fallback' }
  }
}

/**
 * 现在该谁动。
 *
 * @param input.phase - 任务阶段
 * @param input.result - 结构化收尾（缺省 = 按 phase 推导）
 */
export function stageOf(input: { readonly phase: MaestroPhase; readonly result?: MaestroTaskResult | undefined }): MaestroStage {
  const result = input.result ?? fallbackResult(input.phase)
  // 跑着的任务不会"等人"：CLI 进程还在动，任何 human_action 都是它自己的预期，
  // 不是此刻真的阻塞。等人只在它交出控制权之后才成立。
  if (input.phase === 'queued') return 'working/queued'
  if (input.phase === 'running') return 'working'
  if (input.phase === 'interrupted') return 'person/answer'
  if (input.phase === 'failed' || input.phase === 'timeout') return 'person/failed'
  switch (result.state) {
    case 'waiting': return 'person/answer'
    case 'blocked': return 'person/blocked'
    case 'failed': return 'person/failed'
    case 'ready': return 'person/review'
    // progress / dropped / unknown 都已经结束且不需要任何人动。
    case 'progress':
    case 'dropped':
    case 'unknown': return 'idle'
  }
}

/** 需要人动的 stage（看板据此决定"要不要占空间"）。 */
export function needsPerson(stage: MaestroStage): boolean {
  return stage.startsWith('person/')
}
