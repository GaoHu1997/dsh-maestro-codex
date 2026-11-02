# 方案：从 dsh-superagent 借鉴什么（评审稿）

> 对象：https://github.com/deepseek-ai/dsh-superagent-prototype （MIT，研究原型，官方声明「仅供参考、非官方产品」）
> 本地副本：`.tmp/superagent`（`git clone --depth 1`，216 个文件，`src` 约 15.2k 行，`docs` 约 1.75k 行）
> 结论先行：**它的业务域（Source/Eval/Policy/Ticket）不该抄，它的工程骨架（持久化副作用队列、重启恢复语义、健康看板、设置版本化、结构化收尾）值得抄，其中 3 条对本插件是止血级的。**

---

## 1. 对方是什么

一句话：**面向单个 GitHub 仓库的主动式编码代理**——监听 GitHub（可选飞书），把"谁在什么条件下请求了什么"变成带授权的工单（Ticket），给每张工单开独立 DSH 会话和独立目录执行，结果回到原对话（PR / 评论），再用一个 Web 面板只呈现"需要人处理的事"。

它的核心原则写在 `docs/000-philosophy.md`：*用最少的人类注意力，换最大的价值*。所有设计（少概念、少设置、面板只显示需要人的事、健康态不占地方）都服务于这句话。

模块分层（`docs/007-architecture.md`）：

| 层 | 目录 | 行数 | 职责 |
| --- | --- | --- | --- |
| 域模型 | `src/core/` | 2088 | Engine + Intake/Evals/Tickets/Assignments/Replies 五个 part，纯同步、无 I/O |
| 应用胶水 | `src/app/` | 5292 | Runtime、Store(SQLite)、Effects、Outbox、Settings、Prompts、Sessions、HTTP、工具、视图 |
| 客户端 | `src/client/` | 4037 | React 面板（Overview/Source/Trigger/Eval/Execution/Settings 六个 tab） |
| 执行器 | `src/executor/` | 838 | 一工单一 DSH 会话 + 一目录，worker 槽位、后台作业、恢复 |
| 事件源 | `src/sources/` | 2059 | GitHub / 飞书（kind + instance） |

## 2. 与本插件的关系：同层不同向

| 维度 | dsh-superagent | dsh-maestro-codex |
| --- | --- | --- |
| 定位 | 一个**长驻的自主成员**：有触发源、有授权域、有工单生命周期 | 一条**派发通道**：主代理判断后把一次任务交给 codex/claude，取回结果 |
| 执行器 | DSH 自己的会话（可多轮、可续、有工具面） | 外部 CLI 进程（one-shot，`stream-json` / `--json`） |
| 状态源 | SQLite 单文件，一切从库读 | 内存 `TaskRegistry` + `$DSH_HOME/maestro/tasks/*.json` 落盘 |
| 人的位置 | 面板是主要入口（六个 tab） | 面板是辅助（任务看板 tab + 配置页） |
| 强度 | domain 完整、工程量大 | 通道细节极深（模型注入、桥接、账务、续接） |

**所以：它的域模型对我们是过度设计（我们没有"谁被授权请求工作"的问题，工具调用本身就是授权），但它的"外部世界不可靠"这部分工程，恰好是本插件最薄的地方。**

---

## 3. 差距矩阵

| 能力 | superagent 做法 | 本插件现状 | 差距 |
| --- | --- | --- | --- |
| 待办工作持久化 | `effects` 表：`(kind,key)` 唯一 + `seq/generation/attempts/due`，事务内入队、提交后执行 | `runDispatch` 是一次性 async 调用；`controllers` 在内存 Map | ❌ 插件重载即丢运行中任务 |
| 失败退避 | 按 kind 配 `retry: [initial, max]`，`2s→60s` / `5s→300s`；三连败才进健康问题 | `failureRetries 0–2` 同步循环，无退避、无持久化 | ❌ 失败后重试靠一次调用内循环 |
| 重启恢复 | 运行中 Assignment 以 "host restarted" 结束，新 Assignment 带 recovery note（先核对目录/git/远端再重复外部动作），waiting/ready 的不动，按工单创建时间顺序 | `native-recovery.ts` 只恢复**原生镜像**；`loadPersistedTasks` 只回填**已结算**记录 | ❌ 崩溃后不知道有任务被打断 |
| 幂等 | Trigger 只存一次，重复接受只建一张工单 | 无 `dedupe_key`，模型重复派发会重复扣费/重复改文件 | ⚠️ |
| 有序投递 | Outbox：同工单同会话的消息严格有序，前一条未三连败则后一条等待；dropped 记录原因永不重投 | resume 链靠内存锁 + 服务端 409 | ⚠️ 进程内可靠，跨进程不可靠 |
| 健康看板 | `HealthBoard`：每子系统一个条目、单写者、可释放、三连败才报错、健康态不占位 | `hostCapabilities` 只探测宿主能力缺失 | ⚠️ 缺"我正在坏"的观测 |
| 阶段分类 | `person/delivery｜person/answer｜person/review｜person/blocked｜person/failed｜working/queued｜idle` 七态，首匹配优先 | `MaestroPhase` 是内部阶段名 | ⚠️ 卡片说不出"在等谁" |
| 结构化收尾 | Report 枚举 `progress/waiting/ready/blocked/failed/dropped` + 结构化 `human_action` 字段；明确拒绝"从自由文本推断等待人" | 只有 exit code + 最终文本 | ❌ 无法可靠识别"需要人回答" |
| 设置治理 | 版本化设置（revision / base 冲突拒绝 / origin=panel\|tool\|sync）+ 历史 diff + 回滚 | 配置在 `cordis.patch.yml`，插件内无历史 | ⚠️ 门槛被改没人知道 |
| 提示工程 | `prompts/*.md` 拆件 + 覆盖键 + `base` 记录 + **Default updated** 检测 + 逐版本不可变 | 派发前缀/桥接说明写死在代码与工具描述里 | ⚠️ |
| 并发 | `WorkerSlots`：normal 槽 + 人类的**额外 1 槽** + 唤醒优先于新启动 + `Later` 排队 | `Limiter` 只有硬上限 | ⚠️ 人续发会被人自己排挤 |
| 文档纪律 | 编号文档逐级递进 + `tests/docs.spec.ts` 校验文档与代码同步 + `model-surface.spec.ts` 防工具面漂移 | `docs/` 有，无同步测试 | ⚠️ |

---

## 4. 可借鉴清单（按价值排序）

### P0-1 持久化副作用队列（唯一真正止血的一条）

- **借鉴**：`src/app/effects.ts`（161 行，`effect` 表 + `Later` + 退避 + `FAILURES_BEFORE_ERROR=3`）。
- **现状**：`src/dispatch.ts` 里 `runDispatch` 从 spawn 到结算全程一个 Promise；`src/index.ts` 的 `controllers: Map<string, AbortController>` 是唯一句柄。插件被重载（配置保存、宿主重启）时，**运行中的 CLI 进程被杀、任务从任务表消失、`$DSH_HOME/maestro/tasks/<id>.json` 里没有它**。
- **落点**：新增 `src/effects.ts`；`src/task-registry.ts` 的 `MaestroTask` 增加 `state: pending|running|settled` 与 `attempts/due/since`；`src/persist.ts` 负责 load/save。
- **做法**：
  1. 派发前先写 canonical pending 记录（这部分 `src/usage-journal.ts` 已有先例，照它的写法扩到任务主体）；
  2. spawn 变成可重入的 `launch` effect，key = taskId；
  3. 退避分两类：网络/供应商类 `5s→300s`×3，投递类 `2s→60s`；
  4. 槽位不足时抛 `Later`（不计失败、立即重排）——替代现在"卡在 Limiter.acquire"；
  5. `drain()`：关闭时停止取新行、保留未完成行（现在是直接 kill）。
- **收益**：崩溃不丢任务、不重复计费、可精确重试；`persistTasks` 的"落盘"从结果存档升级为状态真相。
- **代价**：中（约 300–400 行 + 迁移）；内存态与落盘态需要一次性对齐，`TaskRegistry.list` 要能读回 pending 行。
- **风险**：别把 effect 队列做成第二个真相源——**允许的唯一写者仍是 TaskRegistry，effects 只持有"要做什么"**。

### P0-2 重启恢复语义（把 interrupted 变成一等状态）

- **借鉴**：`docs/003-execution.md` 的 Restart 一节——运行中的 Assignment 结束为 "host restarted"，新 Assignment 首条消息带恢复提示，要求执行器**先核对目录、git 历史、远端状态，再重复任何外部动作**；waiting/ready/blocked/failed 的不动；按工单创建时间从旧到新恢复。
- **现状**：无 interrupted 概念；重启后旧任务像从未存在。
- **落点**：`src/task-registry.ts`（新 phase `interrupted`）、`src/dispatch.ts`（`recoveryNote` 注入到任务开头）、`src/index.ts` 启动序列（resume 顺序）。
- **做法**：启动时扫描 pending/running 记录 → 标记 `interrupted` 并在看板可点"恢复"；恢复走 `resume`（claude `--resume` / codex `exec resume`）+ 固定前缀提示；顺序按 `createdAt` 升序，避免旧任务被新任务挤死。
- **收益**：与 P0-1 组合后，"中断"从不可见变成可操作；对长任务（20 分钟级别）尤其关键。
- **代价**：小（复用已有 resume 机制），但**恢复提示文案要短**，否则污染任务上下文。

### P0-3 幂等键

- **借鉴**：`docs/001-domain.md` 的 Trigger 幂等（"Accepting a Trigger twice creates one Ticket"）。
- **现状**：模型重试工具调用 = 真的重跑一遍 CLI。
- **落点**：`src/tool.ts` 参数 schema + `src/dispatch.ts`。
- **做法**：可选参数 `dedupe_key`；缺省时按 `(parentSessionId, cli, taskName, cwd)` 在 10 分钟窗口内判定重复，命中则返回已有 taskId 而不启动。窗口与开关进配置。
- **收益**：挡住最常见的重复扣费/重复改文件。
- **代价**：小；风险是"用户确实想再跑一次"——所以必须可显式绕过（传 `dedupe_key: ""` 或新参数 `force`）。

### P1-1 健康看板（HealthBoard）

- **借鉴**：`src/infra/health.ts`（claim/release 单写者 + 三连败才报错 + 健康态不占位）。
- **落点**：新增 `src/health.ts`；由 `index.ts` 在 overview 里合并输出；面板顶部"系统问题"区。
- **条目建议**：`dispatch`（派发失败率）、`spawn`（启动失败/被 kill 树）、`journal`（账本写入）、`bridge`（MCP 桥不可用）、`native-mirror`（原生镜像降级）、`preflight`（模型预检连不通率）。
- **与现有 `hostCapabilities` 的关系**：那是"宿主缺什么能力"，这是"我现在坏没坏"，两者并列、不合并语义。
- **代价**：小（约 120 行 + 一处 UI）。

### P1-2 阶段分类法（看板可读性）

- **借鉴**：`src/app/cards.ts` 的 `TICKET_STATES` + `docs/003-execution.md` 的七态表（首匹配优先、标签说"在等谁"而不是内部状态码）。
- **落点**：`src/client/board/`（卡片）、`src/task-registry.ts`（派生态）。
- **做法**：不改内部 phase，新增一个派生函数 `stageOf(task)`，输出 `person/*`、`working`、`working/queued`、`idle`；看板按它分组，内部 phase 只出现在详情折叠里。
- **代价**：小；收益是"一眼看出该谁动"。

### P1-3 结构化收尾协议

- **借鉴**：Report 六枚举 + `human_action` 结构化字段，以及 `docs/001-domain.md` 明写的拒绝项——"不得从报告自由文本推断'等待人'"。
- **现状**：即使 CLI 说"我需要你确认 A 还是 B"，看板也只有 exit 0 + 一段文本。
- **做法**：在派发任务尾部追加一段**固定收尾协议**（例如最后一行 `MAESTRO_RESULT {"state":"blocked","human_action":"…","summary":"…"}`），解析器宽松（容忍缺字段），解析失败退化为 `state: unknown` + 全文摘要；不伪造。
- **代价**：小；风险是 CLI 不遵守——用"宽松解析 + 明确 unknown"兜住，绝不猜。

### P1-4 CLI 状态查询

- **借鉴**：`scripts/dsh-superagent`（status 输出含 health 错误）。
- **落点**：`scripts/` 下加 `maestro status`，打印 pending/running/interrupted 计数、最近失败、健康条目、用量摘要。

### P2-1 设置版本化

- **借鉴**：`src/app/settings-history.ts` + `docs/004-prompts.md` 的 Versions 一节（revision、base 冲突拒绝、`origin` 区分来源、保存记录受影响对象、历史回滚、面板 diff）。
- **为什么值得**：本插件的 `minTaskDifficulty` / `claudeMinTaskDifficulty` / `codexMinTaskDifficulty` 一旦被改低，**行为静默变化且没人知道**；`taskTypes` 路由表同理。
- **做法**：不接管 `cordis.patch.yml`（那是宿主的），而在插件内维护一份"生效配置快照历史"：每次 `readConfig` 变化时写一条 `{revision, at, origin, diff}`，面板「保存历史」只读展示 + 一键回填。
- **代价**：中；先做只读历史，不做回滚写入。

### P2-2 派发提示模板可编辑 + 默认更新检测

- **借鉴**：`builtInParts` / `base` 记录 / `defaultChanged` / "Default updated" 面板对比。
- **落点**：新增 `prompts/` 目录 + `src/prompts.ts`；先只做一个片段（派发任务的固定前缀与难度门槛说明），带 `base` 记录。
- **收益**：本插件大量行为细节（桥接、难度门槛、沙箱）其实是**写给模型看的文字**，写死在代码里改一次要发版。

### P2-3 并发槽位的人优先

- **借鉴**：`WorkerSlots`——人类消息可多占 1 槽、唤醒优先于新启动、`Later` 排队。
- **落点**：`src/task-registry.ts` 的 `Limiter`。
- **做法**：`acquire(kind: 'launch' | 'reply')`，`reply` 可溢出 1；`launch` 在满额时 `Later`。这与 P0-1 天然配套。

### P2-4 任务工作树准备命令

- **借鉴**：`docs/003-execution.md` 的 prepare command（每工单一个目录，`git worktree` 建检出；执行变量表 `DSH_SUPERAGENT_*`）。
- **为什么**：本插件已支持 `cwd` 与 git 上下文注入，但**并行多个 CLI 任务改同一个工作区**是真实冲突源。
- **做法**：配置项 `prepareCommand`（可选），在 `cwd` 下执行、超时 10 分钟、输出进任务事件流；失败即任务失败并记录输出。不做隔离沙箱承诺（对方也明说"这些是默认值，不是安全边界"）。

### P3 工程纪律

- 文档测试：仿 `tests/docs.spec.ts`，校验 `docs/*.md` 提到的配置项/工具名在代码中存在（防文档腐烂）。
- 工具面防漂移：仿 `tests/model-surface.spec.ts`，快照 `dispatch_cli_task` 的描述与参数，改动必须显式更新。
- 存储：对方用 SQLite + 生成列索引 + 目录锁 + `SCHEMA_VERSION` 单增。**若 P0-1 落地后记录量小，继续用 JSONL 更省事；一旦要查询/分页再换。**

---

## 5. 明确不借鉴

| 不借鉴 | 理由 |
| --- | --- |
| Source / Feishu / GitHub 连接器 | 那是"谁来找我干活"的入口，本插件的入口是主代理的工具调用；引入它等于换产品 |
| Eval / Policy / Mandate / Subscription 全量域模型 | 本插件的授权就是"主代理决定 + 工具参数"，再加一层 Policy/Mandate 只增加概念与失败面 |
| 主会话当评估器（`MasterAssessor`） | 本插件已把难度判断留给主代理（`task_difficulty` + 理由），这是更轻的正确形态 |
| 用 DSH 会话替代外部 CLI 执行器 | 反过来：本插件的价值就是外部 CLI 的模型/沙箱/权限可控性 |
| `Subscription` 扇出与"人话续接"整套规则 | 依赖 Source/Thread 概念，我们没有 Thread |
| 全量面板六 tab | 本插件面板已经"寄生"在宿主 sidebar 上，照抄会变成第二套信息架构 |

## 6. 分阶段路线

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 1 | P0-3 幂等 → P0-2 中断态 → P0-1 持久化队列 | 杀掉插件进程再启动：任务以 `interrupted` 出现在看板，可恢复；重复调用工具不产生第二个任务 |
| 2 | P1-1 健康看板 → P1-2 阶段派生 → P1-4 status | overview 出现"系统问题"区；卡片显示"等待谁"；`maestro status` 打印同样结论 |
| 3 | P1-3 结构化收尾 → P2-3 槽位优先 | 需要人回答的任务在看板上标 `person/answer`，且不靠正则猜 |
| 4 | P2-1 配置历史 → P2-2 提示模板 → P2-4 worktree | 改了门槛能在历史里看到 diff |

## 7. 一句话取舍

本插件的执行通道已经足够深（模型注入、桥接、账务、续接都做了），**再往下钻收益递减；真正的缺口全在"外部世界的不可靠"这一层**——进程会被杀、网络会断、模型会重复调用工具、人需要知道哪张卡片在等自己。superagent 的 `effects` + restart 语义 + `HealthBoard` + 阶段七态，正好是这一层的成熟答案，抄这四个就够，其余按需。

## 8. 实施记录（已完成）

P0 / P1 / P2 三组已全部落地，逐项对照如下。机制说明见 [reliability.md](reliability.md)，测试清单在同文件的表格。

| 方案项 | 实现 | 测试 |
| --- | --- | --- |
| P0-1 持久化副作用队列 | `src/effects.ts`（`launch` 行、同键覆盖、5s→300s 退避、三连败进健康板、`drain` 保留未完成行） | `tests/effects.test.ts` |
| P0-2 重启恢复 | `src/recovery.ts` + `phase: 'interrupted'`（终态但不失败），启动时把挂着的 `launch` 行变成中断任务 | `tests/recovery.test.ts`、`tests/task-registry-reliability.test.ts` |
| P0-3 幂等键 | `src/dedupe.ts`，隐式键 = 父会话+CLI+任务名+cwd，10 分钟窗口；`dedupe_key` 可显式指定；续接不参与 | `tests/dedupe.test.ts`、`tests/dispatch-effects.test.ts` |
| P1-1 健康看板 | `src/health.ts` 七个单写者条目 + `GET /health` | `tests/health.test.ts`、`tests/routes-reliability.test.ts` |
| P1-2 阶段派生 | `src/stage.ts` 七态 + `MaestroTaskSummary.stage` + 看板「等你…」徽标 | `tests/stage.test.ts`、`tests/client-card-detail.test.ts` |
| P1-3 结构化收尾 | `src/result-protocol.ts`（`MAESTRO_RESULT`，只回扫末 40 行，读不到当没说） | `tests/result-protocol.test.ts`、`tests/dispatch-effects.test.ts` |
| P1-4 状态脚本 | `scripts/maestro-status.mjs`（`--json` / `--url`，退出码 0/1/2） | `tests/maestro-status.test.ts` |
| P2-1 配置历史 | `src/config-history.ts`（脱敏快照 + 五种差异码）+ `GET /config-history` | `tests/config-history.test.ts` |
| P2-2 提示模板 | `src/prompts.ts`（三段可改 + `base` 指纹判 `stale`）+ `/prompts`、`/prompts/save` | `tests/prompts.test.ts`、`tests/routes-reliability.test.ts` |
| P2-3 槽位优先 | `Limiter(limit, humanOverflow=1)`，人可用溢出槽，普通派发不插队 | `tests/limiter-priority.test.ts` |
| P2-4 就绪命令 | `src/prepare.ts` + 配置项 `prepareCommand`（≤4000 字符，失败不启动 CLI） | `tests/prepare.test.ts`、`tests/config.test.ts`、`tests/dispatch-effects.test.ts` |

与最初方案的三处偏离，都是实现时发现原方案不对：

1. **`routingHint` / `replyPrefix` 出厂为空**。原方案说这两段默认可改写；实现后发现路由提示由 `routing.ts` 按当前配置动态生成（含门槛与候选 CLI），出厂再写一份同义句子必然漂移。改成"只放团队想补的那一句，出厂为空"，默认输出与改造前逐字一致。
2. **结构化收尾不进工具输出**。原方案想把它塞进 `TOOL_OUTPUT_SCHEMA`；实现时决定不动工具契约（`additionalProperties: false` 的输出面是模型侧稳定接口），收尾只进看板详情与事件流。
3. **健康板不与 `hostCapabilities` 合并**。两者回答不同问题：一个讲"运行时现在出没出问题"，一个讲"宿主版本缺不缺成员"。合并会让任一侧的缺失被另一侧掩盖。

测试总量从 **59 文件 / 1042 例**（改造前基线）到 **74 文件 / 1158 例**，两路 `tsc --noEmit` 全绿。
