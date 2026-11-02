# 可靠性面

这组机制来自对 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的工程骨架借鉴（对照方案见 [设计记录](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/docs/plan-borrow-from-superagent.md)）。对方假设"外部世界会失败"：GitHub 会 502、进程会被重启、模型会重试。本插件同样是外部执行者——CLI 子进程、网关、宿主 seam 都会断——所以只抄这几层骨架，不抄它的产品概念（Source / Ticket / Eval / Mandate）。

## 1. 持久化副作用队列（`src/effects.ts`）

一次派发在 spawn 之前往 `$DSH_HOME/maestro/effects.json` 落一行 `launch`：

```json
{ "kind": "launch", "key": "task-…", "value": { "cli": "claude", "prompt": "…", "cwd": "…" }, "attempts": 0, "due": 0 }
```

- 同 `kind + key` 只保留一行（重复入队会 `generation + 1` 并重置尝试次数，旧代的 `settle/fail` 直接失效）。
- 失败按 `5s → 10s → … → 300s` 退避，连续 3 次记 `error` 并写入健康面板（`effects` 条目），不再重试。
- 任务走到任意终态就 `settle`，把行清掉；`drain()` 关闭时只停写不删行——崩溃留下的行才是下次启动要解释的东西。

它不是"重启后自动重跑"：重跑外部 CLI 可能重复改文件，代价比看懂一句"上次没跑完"高得多。所以它负责**留下痕迹**，恢复语义交给下一节。

## 2. 重启恢复：`interrupted` 阶段

`MaestroPhase` 新增 `interrupted`：**终态，但不是失败**。没有结论、没有退出码，只是"进程死了"。

启动时 `restoreInterrupted` 读取队列里还挂着的 `launch` 行，按 tasks 的标题/cwd/cli 重建一条 `interrupted` 任务，事件流里写明"已中断：上次退出时这个任务还没跑完"，然后把行 settle 掉。

看板上的表现：阶段显示「已中断」，`stage` 是 `person/answer`（**等你决定要不要重新派发**），而不是 `person/failed`（去看错误原因）。恢复任务不带着跑，因为上一次跑到哪一步只有人知道。

## 3. 幂等键（`src/dedupe.ts`）

同一父会话、同 CLI、同任务名、同 cwd 在 **10 分钟**内重复派发，第二次直接抛 `DuplicateDispatchError`，不 spawn。模型可以显式传 `dedupe_key` 覆盖隐式键（比如按 PR 号去重），续接（`resume`）不参与去重——同一会话多轮往返本来就该重复。

失败会立刻 `release` 键：**没跑起来的不占窗口**，否则一次网关抖动会把重试锁死 10 分钟。

## 4. 健康面板（`src/health.ts`，`GET /health`）

七个单写者条目：`dispatch / spawn / effects / persist / bridge / native-mirror / preflight`。每条只有 `ok | degraded | error` 和一句中文影响说明，`claim(name)` 只允许一个持有者（重复认领会抛错），未认领的条目不出现在面板里——**健康态不占空间**。

顺序固定按声明序，不按时间排：面板刷新两次，条目位置不该跳动。`worst()` 给整体结论，`problems()` 只给需要看的。这取代不了已有的 `hostCapabilities` 报告（那个讲宿主版本差异），两者并列。

## 5. 阶段派生（`src/stage.ts`，`GET /status`）

`phase` 说的是任务走到哪一步，`stage` 说的是**现在需不需要人**：

| stage | 什么时候 |
| --- | --- |
| `person/answer` | 结构化收尾要你回话；中断的任务也在这里 |
| `person/review` | 跑完了，等你看结果 |
| `person/blocked` | 它说自己被卡住了 |
| `person/failed` | 失败或超时，要你决定 |
| `working/queued` | 排队等槽位 |
| `working` | 正在跑 |
| `idle` | 已结束且不需要人（也含 npm 安装作业） |

`GET /status` 给出七个计数的快照、`needsPerson` 总数、`pendingEffects` 与 `problems`，作为 `maestro status` 脚本的机器可读来源。

## 6. 结构化收尾（`src/result-protocol.ts`）

派发时在任务末尾追加一行说明，CLI 可以用一行 JSON 交代自己的状态：

```
MAESTRO_RESULT {"state":"blocked","human_action":"确认线上库能否直连","summary":"卡在权限"}
```

- 只回扫最后 40 行，坏行继续往前找，读不到就当没说——**绝不从自由文本里猜**。
- `state ∈ progress / waiting / ready / blocked / failed / dropped / unknown`；提示写 `ready`/`blocked` 才影响 `stage`。
- 结果是展示层信息：写进看板详情与事件流，**不改工具输出契约**（工具仍返回 `finalText`），老模型不写协议行时退回 `fallbackResult(phase)`。

## 7. 就绪命令（`prepareCommand`）

配置项 `prepareCommand`（默认空，≤4000 字符）在 spawn CLI 之前于任务 cwd 跑一次，典型用途是 `git worktree add`。超时 10 分钟，输出截断到 2000 字符；失败直接让本次派发 `failed` 且**不启动 CLI**——前置条件没谈成，跑起来只会踩同一个坑。

## 8. 配置历史（`src/config-history.ts`，`GET /config-history`）

每次配置生效（`effectiveOf` 的扁平化结果）与上一次签名不同时记一条快照，保留 50 条，30 秒内重复轮询不追加。差异码只有五种：`enabledOn / enabledOff / cliEnabled / cliDisabled / fieldChanged`。

密钥先过 `redactEffective` 再入历史，历史文件里不会出现 token 明文。

## 9. 提示模板（`src/prompts.ts`，`GET /prompts`、`POST /prompts/save`）

三段可由人改写的文本：`resultProtocol`（结构化收尾说明）、`routingHint`（写进主会话系统提示的路由建议）、`replyPrefix`（续接指令前缀）。每条记录出厂正文的指纹（`base`），出厂默认改动后旧覆盖会标 `stale`——**显式告诉你"默认更新过了，你那份可能过期"**，而不是偷偷沿用。

## 10. `maestro status`

```bash
node scripts/maestro-status.mjs             # 打一份人看的快照
node scripts/maestro-status.mjs --json      # 机器读
node scripts/maestro-status.mjs --url http://127.0.0.1:11061
```

读 `GET /plugin/dsh-maestro-codex/status`，退出码 **0** 无健康问题 / **1** 连接、HTTP 或 JSON 读取失败 / **2** 存在 `degraded` 或 `error` 健康条目。脚本随安装包交付，只依赖 Node（与插件相同的 `>=22.19`，使用内置 `fetch` 与 `AbortSignal.timeout`），不依赖其他 `scripts` 或源码。请在安装包目录执行；`--url` 或 `MAESTRO_WEB_URL` 应指向正在运行的真实 DSH 地址，示例端口不保证与当前宿主相同。

## 兼容性

- `stage` / `result` 是摘要上的**新增可选字段**，老客户端忽略即可。
- `interrupted` 是新阶段：新客户端显示「已中断」，老客户端会落到未知分支，但不会崩。
- 落盘文件都带 `version` 字段，读到未来版本时按"不认识的当空"处理并 `warn`，不抛。

## 测试

都是常规 vitest，跟源码同层：

| 文件 | 覆盖 |
| --- | --- |
| `tests/effects.test.ts` | 去重、退避、三连败进死信、`drain` 保留未完成行、坏文件容错 |
| `tests/dedupe.test.ts` | 隐式/显式键、窗口、失败释放、容量上限 |
| `tests/health.test.ts` | 单写者、固定顺序、`worst/problems` |
| `tests/stage.test.ts` | 15 组 (phase, result) → stage 映射 |
| `tests/result-protocol.test.ts` | 窗口、坏行回退、截断 |
| `tests/recovery.test.ts` | 队列行 → `interrupted` 任务 |
| `tests/prepare.test.ts` | 平台 shell、非零退出、超时、输出截断 |
| `tests/config-history.test.ts` | 扁平化、密钥脱敏、debounce、保留条数 |
| `tests/prompts.test.ts` | 覆盖、`stale` 检测、复位、长度上限 |
| `tests/dispatch-effects.test.ts` | 端到端：入队/结算、收尾解析、去重、人优先槽位、就绪命令失败 |
| `tests/routes-reliability.test.ts` | 四个新路由的状态码与返回形状 |
| `tests/persist-reliability.test.ts` | `result` 与 `interrupted` 的落盘/读回 |
| `tests/task-registry-reliability.test.ts` | 中断任务的终态语义、npm 作业落 `idle` |
| `tests/limiter-priority.test.ts` | 人优先、溢出槽、abort、容量变更 |
