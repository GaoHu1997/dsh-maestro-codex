/**
 * CLI 任务镜像（docs/plan-cli-task-visible-in-tasks-panel.md 方案 B 的落地）：
 * `dispatch_cli_task` 执行时用 `exec.agent.id` 作 owner 把同一次 runDispatch
 * 登记进宿主的 jobs 服务——dsh 原生「任务管理」页（better-sidebar）于是能看到
 * 这条 CLI 子代理：运行中状态、流式输出、抽屉里可终止、新任务自动切页。
 *
 * 铁律：**镜像只是旁路，绝不改变工具语义**。
 * - runDispatch 的 promise 只创建一次（`valuePromise`），既交给 job 的 done
 *   也交给工具返回——两条消费方拿到的是同一次执行。
 * - `jobs.start` 抛错（每 owner 并发上限、服务缺席）→ 静默降级为裸 dispatch，
 *   且只降级一次（run 尚未被调用才会走裸路径，避免双跑）。
 * - 抽屉「终止」→ abort runDispatch 登记的 controller（取消语义与配置页一致）。
 *
 * 这里同时提供 A2 的一小块：派发开始时往父会话追加一行 `subagent/catalog`
 * （`mode: 'external'`）——内核会话顶部的「N 个子智能体」下拉框立刻能看到
 * 这条 CLI 子代理（external 行不可打开，只作为任务记录）。
 */

import { runDispatch, type DispatchDeps, type DispatchParams, type DispatchValue } from './dispatch.js'

/** The job-handle slice the mirror writes through. */
export interface JobHandleFace {
  append(text: string, options?: { channel?: 'stdout' | 'stderr' | 'log' }): void
  updateProgress(line: string): void
}

/** One settled job outcome as the jobs service expects it. */
export interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  result?: string
}

/** The jobs-service face the mirror needs (structural; dsh-jobs-local). */
export interface JobsFace {
  start(spec: {
    kind: string
    label: string
    owner: string
    outputLimitBytes?: number
    run(handle: JobHandleFace): { cancel(reason?: string): void; done: Promise<JobOutcome> }
  }): string
}

/** Accept any object that structurally satisfies {@link JobsFace}. */
export function jobsFaceOf(service: unknown): JobsFace | undefined {
  if (typeof service !== 'object' || service === null) return undefined
  const start = (service as { start?: unknown }).start
  if (typeof start !== 'function') return undefined
  return { start: (spec) => (start as (spec: unknown) => string).call(service, spec) }
}

/** A2 的 catalog 行：与宿主 establishExternalCatalogChild 的事件载荷同形。 */
export function externalCatalogRow(taskId: string, label: string, now: number): Record<string, unknown> {
  return { version: 2, childId: `cli-${taskId}`, childCreatedAt: now, mode: 'external', label }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one dispatch mirrored into the jobs service. Resolves with the exact
 * {@link DispatchValue} a bare runDispatch would return; failures map to
 * `killed` (user stop) or `failed` (everything else) on the job row only.
 */
export async function mirrorAsJob(options: {
  jobs: JobsFace
  owner: string
  label: string
  deps: DispatchDeps
  params: DispatchParams
  signal: AbortSignal
  /** 任务 id 一创建就回调（tool 用它立刻写 external 目录行）。 */
  onTaskId?: (id: string) => void
}): Promise<DispatchValue> {
  const { jobs, owner, label, deps, params, signal, onTaskId } = options
  let taskId: string | undefined
  let handle: JobHandleFace | undefined
  let valuePromise: Promise<DispatchValue> | undefined
  const run = (): Promise<DispatchValue> => {
    valuePromise ??= runDispatch(deps, params, signal, {
      onTaskId: (id) => { taskId = id; onTaskId?.(id) },
      onEvent: (kind, text) => { handle?.append(text, { channel: kind === 'error' ? 'stderr' : 'stdout' }) },
      onPhase: (phase, note) => { handle?.updateProgress(note === undefined || note.trim() === '' ? phase : note) },
    })
    return valuePromise
  }
  try {
    jobs.start({
      kind: 'cli',
      label,
      owner,
      outputLimitBytes: 256_000,
      run: (jobHandle) => {
        handle = jobHandle
        return {
          cancel: (reason?: string) => {
            if (taskId !== undefined) deps.controllers.get(taskId)?.abort(new Error(reason === undefined || reason.trim() === '' ? '已从任务页终止' : reason))
          },
          done: run().then(
            (value) => {
              handle?.append(value.finalText, { channel: 'stdout' })
              return {
                status: 'completed' as const,
                detail: `exit ${String(value.exitCode ?? 0)} · ${String(Math.round(value.durationMs / 1000))}s · ${value.cli}`,
                result: value.finalText.slice(0, 4_000),
              } satisfies JobOutcome
            },
            (error: unknown) => {
              const message = messageOf(error)
              // 取消/终止的措辞不止一种：工具侧「任务已取消」、任务页「已从任务页终止」、
              // 底层 AbortError——都映射为 killed，其余才是 failed。
              const killed = signal.aborted || /已取消|终止|abort/i.test(message)
              return killed
                ? { status: 'killed' as const } satisfies JobOutcome
                : { status: 'failed' as const, detail: message } satisfies JobOutcome
            },
          ),
        }
      },
    })
  } catch (error) {
    // job 上限已满 / 服务拒绝：可观测性降级，任务照跑。run 若已被调用（罕见）
    // 就复用同一个 promise，绝不双跑。
    deps.logger?.warn(`dsh-maestro-codex: 任务页镜像不可用（${messageOf(error)}），任务继续执行`)
    return valuePromise ?? runDispatch(deps, params, signal)
  }
  return run()
}
