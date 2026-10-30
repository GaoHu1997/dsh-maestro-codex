# 方案：让 CLI 子代理出现在右侧「任务管理」面板

> **已被取代（2026-10）**：用户改选「自建任务看板」——本插件用 `ctx.betterSidebar.registerTab` 注册独立的「任务看板」tab，把 DSH 主任务/子任务、CLI 子代理、后台任务放进同一页，而不是往 `dsh-better-sidebar` 的任务页里塞数据（那个页面对 `external` 子级没有实时态，塞进去也只能显示「已完成」）。实现见 `src/client/board/`，设计说明见 [task-board.md](task-board.md)。本文保留为调研记录。
>
> **更新（2026-10-30）**：文中的**方案 B（镜像成后台 job）与 A2（external 目录行）已实施**——见 `src/job-mirror.ts`（`mirrorAsJob` / `externalCatalogRow`，配置项 `mirrorAsJob`，默认开）与 `src/tool.ts` 的接线。行为与 §3/§5 的设计一致：job 只是旁路镜像，`jobs.start` 失败静默降级为裸 dispatch，工具返回不变。任务看板与 dsh 原生任务页从此共用同一次派发的事实源。
>
> 目标：主代理调用 `dispatch_cli_task` 派发 claude/codex 后，右侧「任务管理」tab（截图红框）能显示这个任务——至少要有「正在运行 / 已完成 / 失败」、实时输出、可强制终止。

## 1. 现状诊断：为什么现在看不到

红框里的面板**不是 DSH 内核**，是第三方插件 `dsh-better-sidebar`（`~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar`）的 `subagent` tab。它的任务页只有三个数据来源：

| 区块 | 数据来源 | 我们的 CLI 任务 |
| --- | --- | --- |
| 拓扑树 / 工作流图 | `ctx.get('subagents').listDescendants(rootSessionId)`（读父会话的 `subagentCatalog` 投影）+ `subagents.live` 折叠每会话 process 摘要 | ❌ 不是 subagent，零记录 |
| 底部「后台任务」 | `jobs.list` / `watchRows`（按 owner session 授权） | ❌ 不是 job，零记录 |
| 工作流运行 | workflow engine 的运行记录 | ❌ 不是工作流 |

`dispatch_cli_task` 走的是插件自己的 `runDispatch` → spawn 子进程 → 内存 `TaskRegistry`，只在**本插件配置卡片**里可见（轮询 `/dsh-maestro-codex/tasks`）。任务页对它一无所知。所以要么**把自己伪装成 subagent**（A），要么**把自己登记成 job**（B），否则任何改法都进不去这个 tab。

关键约束（已核对的硬证据）：

- `listDescendants`（`@deepseek-ai/dsh-subagent/lib/index.js:2366`）对每行的活跃度判定是 `activity: sessions.get(entry.id) === void 0 ? "inactive" : "running"`，且 `children = entry.mode === "external" ? [] : await readChildren(entry.id)`。→ **external 子级永远 `inactive`**，没有任何事件流可折叠。
- `tasks-model.ts:312 buildTasksModel` 里 external 行不会被丢弃，但 `state = activity === 'running' ? 'running' : 'done'`。→ external 节点**恒显示「已完成」**。
- `startActivation({delivery})`：`'parent'` 才写 `subagent/catalog` 行（`lib/index.js:1487-1530` 的 `establishExternalCatalogChild`），且会额外给对话注入一条 user 角色完成通知；`'caller'` 不发通知但也**不写 catalog**（workflow 用它）。
- `jobs.start({kind, label, owner, run})` 的 `owner` 必须是**活的** agent session（`dsh-jobs-local/lib/index.js:537-544`），且要求 `servesOwner` 通过（同组合装了 `@deepseek-ai/dsh-tool-jobs`——本会话已有 `job_output`/`job_list`/`job_kill`，成立）。
- `dsh-better-sidebar` 只对外暴露 `ctx.betterSidebar.registerTab / registerFileViewer / registerFileIcon`，**没有任何「往任务页注入数据源」的扩展点**。

## 2. 三条通路对比

| | A 伪装成 external 子代理 | **B 登记成后台 job（推荐）** | C 自建独立 tab |
| --- | --- | --- | --- |
| 出现在任务管理 tab | ✅ 拓扑树里一个节点 | ✅ 底部「后台任务」区一行 | ❌ 旁边的另一个 tab |
| 运行中状态 | ❌ 恒「已完成」（内核限制） | ✅ 运行中/收尾/结束 + 计时 | ✅ |
| 实时输出 | ❌ 无 session 可折叠 | ✅ 点开抽屉看流式输出 | ✅（自绘） |
| 强制终止 | ❌ | ✅ 抽屉里 kill → abort 子进程 | ✅ |
| 自动切到任务页 | ❌ | ✅ 见 §3.4 | ❌ |
| 对话副作用 | 多一条 user 角色完成通知 | 一条 job 结束通知（可接受） | 无 |
| 改动量 | 大（provider + 工具语义改异步） | 小（~80 行，纯增量） | 中（新 tab + 前端） |
| 依赖 DSH 内部语义 | 高 | 中（只用公开 `jobs.start`） | 无 |

**结论：先做 B。** A 若要补「拓扑树里也有个节点」，用 A2（见 §5）以配置开关叠加，代价是可接受的「点不进去」的叶子节点。

## 3. 方案 B：把 dispatch 登记成后台 job（主推）

### 3.1 一句话

在 `dispatch_cli_task` 的 `execute(args, exec)` 里，拿 `exec.agent.id` 作 owner 调 `ctx.get('jobs').start(...)`，把已有的 `runDispatch` 包在 `run(handle)` 里；dispatch 的事件流通过 `handle.append(text, {channel})` 实时进 job 输出环。工具**仍然同步返回**原来的 `DispatchValue`——job 只是旁路镜像，不改变工具语义。

### 3.2 改哪些文件

| 文件 | 改动 |
| --- | --- |
| `src/job-mirror.ts`（新增，~90 行） | `JobsFace` 最小接口 + `mirrorAsJob()`：包装 start/cancel/done、把 abort 映射成 `status:'killed'`、`jobs.start` 抛错时静默降级为裸 `runDispatch` |
| `src/dispatch.ts` | `runDispatch(..., hooks?: { onTaskId?, onEvent?, onPhase? })`：在现有 `onEvent`/`setPhase` 处旁路调用（`dispatch.ts:185-187`、`dispatch.ts:183`）；结束时补一条汇总事件 |
| `src/tool.ts` | `execute(rawArgs, exec: {signal, agent?})`：有 `agent` 且有 jobs 时走 `mirrorAsJob`，否则原样 `runDispatch`；`MaestroToolDeps` 增加 `jobs?: () => JobsFace \| undefined` |
| `src/index.ts` | 注册工具时注入 `jobs: () => ctx.get('jobs')`；新增配置项 `mirrorAsJob`（默认 true） |
| `src/config.ts` | 新增 `mirrorAsJob: boolean`（配置卡片加一个开关，schema 同步） |

### 3.3 骨架

```ts
// src/job-mirror.ts
export interface JobHandleFace {
  append(text: string, options?: { channel?: 'stdout' | 'stderr' | 'log' }): void
  updateProgress(line: string): void
}
export interface JobsFace {
  start(spec: {
    kind: string; label: string; owner: string; outputLimitBytes?: number
    run(handle: JobHandleFace): {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; result?: string }>
    }
  }): string
}

export async function mirrorAsJob(jobs: JobsFace, owner: string, label: string, deps: DispatchDeps, params: DispatchParams, signal: AbortSignal): Promise<DispatchValue> {
  let taskId: string | undefined
  try {
    jobs.start({
      kind: 'cli', label, owner, outputLimitBytes: 256_000,
      run: (handle) => ({
        // 抽屉里的「终止」→ abort 现有 controller（runDispatch 已把它登记在 deps.controllers）
        cancel: (reason) => { if (taskId !== undefined) deps.controllers.get(taskId)?.abort(new Error(reason ?? '已从任务管理终止')) },
        done: runDispatch(deps, params, signal, {
          onTaskId: (id) => { taskId = id },
          onEvent: (kind, text) => handle.append(text, { channel: kind === 'error' ? 'stderr' : 'stdout' }),
          onPhase: (phase, detail) => handle.updateProgress(detail ?? phase),
        }).then(
          (value) => ({ status: 'completed' as const, detail: `exit ${value.exitCode ?? 0} · ${Math.round(value.durationMs / 1000)}s · ${value.cli}`, result: value.finalText.slice(0, 4000) }),
          (error) => isAbort(error) ? { status: 'killed' as const } : { status: 'failed' as const, detail: messageOf(error) },
        ),
      }),
    })
  } catch (error) {
    // job 上限已满 / 没有 controller：可观测性降级，任务照跑
    deps.logger?.warn(`maestro-codex: 任务页镜像不可用（${messageOf(error)}），任务继续执行`)
    return runDispatch(deps, params, signal)
  }
  // job 事件已经在上面的 promise 链里跑完，这里只等同一个 promise：
  // 重新 await 需要共享 promise → 实现上让 mirrorAsJob 保存 valuePromise 并 await 它
}
```

> 实现细节：`runDispatch` 的 promise 必须只创建一次并存变量（`valuePromise`），既交给 `done` 也交给工具返回；最后补 `handle.append(finalText, {channel:'stdout'})` 让抽屉里有完整结论。

### 3.4 用户在界面上会看到什么

1. 主代理调 `dispatch_cli_task` 的瞬间，任务页底部多一行：`cli · 代码生成 - 给 xxx 加测试`，状态「运行中」，计时在走。
2. better-sidebar 的 `use-host-feeds.ts:321-329` 有 `detectNewJob(prev, rows, since)` → `activateTasksPage(...)`：**新 job 出现时自动把右栏切到「任务管理」**（受偏好 `autoOpenJobs`、窄屏开关、`subagent` tab 是否启用约束）。这正是「触发 CLI 子代理后右侧显示」的观感。
3. 点这行 → 抽屉：标题 = label、tag = kind(`cli`)、detail = `exit 0 · 42s · codex`、正文 = 流式输出，底部「跟随尾部 / 终止」。
4. CLI 结束，行变为「已完成 / 失败 / 已终止」，`result` 作为 job 结果保留。

### 3.5 副作用与边界

- **多一条通知**：`@deepseek-ai/dsh-tool-jobs` 会为同 owner 的 job 广播结束通知（含结果文本），与工具同步返回的内容重复。可接受；如介意，把 `result` 留空、只留 `detail`。
- **job 上限**：`dsh-jobs-local` 有每 owner 并发上限，超限 `jobs.start` 抛错 → 走 §3.3 的降级分支，功能可用性不受影响。
- **owner 必须活着**：工具执行时 `exec.agent` 一定活着；若该 agent 是子代理会话，owner 就是它——任务页按树枚举 `treeSessionIds` 仍能看到。
- **卡片手动派发没有 agent**：`runDispatch` 被配置卡片的 `/dispatch` 路由复用时没有 `exec.agent`，自然不镜像，行为不变。
- **通道选择**：`stdout`/`stderr` 会被模型侧的 `job_output` 读到（`dsh-tool-jobs/lib/index.js:62` 只过滤 `log`），但模型没有理由去读这个 job；若想彻底不外泄，改 `channel:'log'`（UI 仍展示，模型侧过滤）。

## 4. 方案 A（可选叠加）：拓扑树里多一个节点

### A1 真 external provider（语义正确，改动大）

1. `ctx.subagents.registerProvider({ name: 'cli-maestro', capabilities: {...}, inheritsParentContext: false, start(request) {...} })`；
2. `start()` 里跑 CLI，返回 `{ id, result: Promise<{output:[{type:'text',text:finalText}], stopReason}>, dispose }`；
3. 工具的 `execute` 改成 `subagents.startActivation({provider:'cli-maestro', label, request:{prompt, parent, cwd, agentOptions:{cli,model,timeoutMinutes}}, signal, delivery:'parent'})`，再 `await activation.result` 映射回 `DispatchValue`。

代价：工具语义变成「激活 + 等结果」；多一条 user 角色完成通知；节点仍恒「已完成」且无输出；`cli/model/timeout` 只能借 `agentOptions` 这条旁路传，脆弱。**不建议现在做。**

### A2 只补一行 catalog（10 行，可选）

```ts
const childId = `cli-${randomUUID()}`
exec.agent.session.append('subagent/catalog', {
  version: 2, childId, childCreatedAt: Date.now(), mode: 'external',
  label: `cli · ${title}`,
})
```

- 拓扑树里出现一个叶子节点（external 不展开子级），状态「已完成」，页头「N 个子代理」+1。
- 建议**在任务结束时写**（`✓` 语义才诚实），运行中只靠 §3 的 job 行显示。
- 副作用：点这个节点跳不到任何会话；`send_message` 到它会报不支持；会话里多一条 catalog 事件（模型不可见）。

## 5. 方案 C（备选）：自建「CLI 任务」tab

`ctx.betterSidebar.registerTab({...})` 注册一个独立 tab，复用插件已有的 `/tasks` + `/task-detail`（`src/client/MaestroCard.tsx` 已有任务列表与事件日志渲染，可抽出复用）。

- 优点：UI 完全自主，能画时间线、事件分级、复制最终文本、批量终止；不依赖 DSH 内部语义。
- 缺点：不在「任务管理」tab 里；需要前端新组件 + 打包产物验证。

## 6. 验收清单（方案 B）

- [ ] 主代理调 `dispatch_cli_task` → 右栏自动切到「任务管理」，底部出现一行，状态「运行中」。
- [ ] 抽屉里能看到 CLI 的流式输出（含 `registry.push` 的 note/error）。
- [ ] 点「终止」→ 子进程被 kill，行状态「已终止」，工具返回失败且 `notes` 说明被终止。
- [ ] 工具返回值与改造前完全一致（`ok/cli/model/cwd/durationMs/exitCode/sessionRef/finalText/notes`）。
- [ ] `mirrorAsJob: false` 或没有 jobs 服务时，行为与今天一致（回归）。
- [ ] 卡片手动派发（无 agent）不产生 job，行为不变。
- [ ] `pnpm typecheck && pnpm test` 通过；新增 `job-mirror` 单测（降级分支、killed 映射、事件透传）。

## 7. 实施顺序与工作量

1. `src/job-mirror.ts` + `dispatch.ts` 的 hooks（0.5 天，含单测）
2. `src/tool.ts` / `src/index.ts` / `src/config.ts` 接线 + 配置开关（0.5 天）
3. 本地加载插件，真实跑一次 codex / claude 任务，按 §6 验收（0.5 天）
4. 可选：A2 节点（0.5 天）、C tab（1.5 天）

## 8. 风险

| 风险 | 处理 |
| --- | --- |
| `jobs.start` 在某些组合下不可用 | 捕获后降级为裸 dispatch，只丢可视性 |
| 结束通知与工具结果重复 | `result` 只放摘要，或置空 |
| 每 owner 并发上限 | 超限降级，不阻塞任务 |
| 上游改 `jobs.start` 契约 | `JobsFace` 只依赖 `start/append/updateProgress/cancel/done` 五个成员，集中在一个文件 |
