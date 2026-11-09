# 任务看板（右侧栏 tab）

## 原版移植

任务界面直接移植自 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) **0.28.2**，不再使用旧版 `dmb-*` 纵向缩进卡片。图布局、SVG 贝塞尔连线、点阵背景、卡片两段结构、深度配色、树视图、折叠控件、详情浮层、后台任务抽屉均复用原版实现。

- 图视图是真正的分层绝对定位画布；按容器宽度排布，滚轮围绕鼠标缩放，只允许从背景拖动画布。
- 保留原版缩放范围 `0.4–2`、适配可读下限 `0.78`、适配上限 `1.3`、`220ms` 布局与视口动画。
- 标题栏使用原版 36px 高度、字体、间距、分隔线和宿主 ghost 刷新按钮。
- 图/树切换、自动折叠、缩放与适配按钮保留原版位置。取消旧的独立筛选工具栏，不往原版 UI 增加设计元素。
- 使用宿主的 React 和 UI primitives，原版 `--dsw-*` 主题变量直接继承亮/暗主题。
- 布局、动画与 CSS 按原始字节保存；4 个渲染文件以 `adapted-cli-badge-and-interrupted-state` 明确记录白名单适配：隔离的 CLI `executor` 标识、既有状态槽及读屏名称中的可选 `stateText`，以及折叠计算前的作用域内 CLI 状态映射。已中断 CLI 按空闲/等待处理，不伪造原生运行标记，不藏进“已完成”组；真正完成的兄弟仍正常折叠，原生节点未传适配字段时输出保持原样。测试逐一还原精确插入/替换，并对比独立固定的 0.28.2 原版 SHA-256，不以修改基准哈希代替验收。源文件哈希见 [source-manifest.json](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/src/client/board/upstream/source-manifest.json)，MIT 许可见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES)。CSS Modules 编译后内联进客户端包，不依赖宿主额外加载样式文件。

## 座位与数据

通过可选的 `betterSidebar.registerTab` 注册 `maestro-board`，标题「任务看板」、`order: 45`、`single: true`。没有安装 better-sidebar 时不显示看板，其余 CLI 功能不受影响。

| 数据 | 来源 | 行为 |
| --- | --- | --- |
| 会话树 | `sessions.list.byId`、血缘与 `subagentCatalog` 投影 | 向祖先找到根，合并目录与血缘，保留子代理任务描述 |
| CLI 子代理 | `/plugin/dsh-maestro-codex/tasks`、`/task`、`/task/cancel` | 列表 2.5s、展开详情 900ms 轮询；由可信父会话 capability 授权，sessions 只收窄范围 |
| 用量与耗时 | `tokenUsage`、`subagentTiming`、`maestroCliUsage` | 映射进原版卡片元信息和详情 |
| 原生子代理状态 | `sidebar/api/subagents.live` | 沿用原版 3s 刷新，实时 activity / done / error 不由 CLI 状态覆盖 |
| 工作流 | `sidebar/api/workflows.list` | 沿用原版 5s 刷新、工作流卡片、成员节点与详情/导航 |
| Agent Team | `agentTeam` 投影与原生 live | 原版 TeamBoard / TaskWindow，创建与 CAS 更新复用已有 teams API |
| 后台任务 | 宿主 `jobs.state`、`watchRows`、`observe`、`kill` | 独立原版 JobsDrawer，钉在看板底部、固定占 1/5 高度（`jobs-dock.ts` 注入槽位样式）；有 jobs 服务时常驻，空列表显示中英文空态，仅缺少该服务时不渲染 |

不新增 host 路由，不修改模型路由、难度门槛、权限或续接契约。CLI 超时保护的修正见下文。隐藏看板时停止列表/日志轮询及作业观察。看板读取原版 SidebarStore 的图/树与自动折叠偏好；后台任务抽屉不再跟随「代理较多自动收起」偏好——槽位固定占 1/5 高度，若在 8 个子智能体后自动折叠就只剩 28px 标题栏，所以抽屉默认展开，点标题栏仍可手动折叠（折叠时槽位退回标题栏高度，不留空白）。保留原版 `<768px` 窄屏默认树视图。

团队任务的正文、编辑控件与窗口使用原版组件。Markdown 的宿主文件导航是显式兼容适配：只有宿主提供 `openMarkdownFile` 时才打开本地 Markdown 链接，不伪造 explorer 路由或完整跨文件锚点能力。

## CLI 接入边界

任务仍归属于最初的父会话，续接不会把 owner 改成当前 CLI 子会话。已授权的父会话、任务自己的 CLI 子会话，以及该任务真实续接链上的祖先视图可读取和控制该分支；同一父会话下的兄弟任务或另一条分支不能因此借权。`sessions` 仅收窄范围，不增加权限。

新任务的 `replySessionIds` 是服务器根据已登记锚点派生的非秘密视图标识，最多 60 项，保留最初视图与最近祖先，以支持内存裁剪、结算历史恢复和中断队列恢复。普通派发不能提供该字段来增加权限；运行时 capability token 不进入任务历史或投影 checkpoint。旧记录只沿当前可验证的同 owner、同 CLI 链兼容读取，缺失祖先不猜测授权。

[model.ts](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/src/client/board/model.ts) 的 `buildSessionTree` 构建骨架，`attachRows` 按 `MaestroTaskSummary.sessionId` 挂接 CLI 节点：

- id 为 `cli:<taskId>`，避免与原生会话 id 冲突。
- 树外归属任务丢弃；无归属安装任务保持既有可见语义。
- 对应 CLI 的目录/会话镜像节点去重（旧 external 幽灵行与新的原生记录会话同 id `cli-<taskId>`，都折叠进富信息的 CLI 行），不重复出节点。
- CLI 仍使用原版代理卡片，身份栏/树标题右侧明确标识 `codex`、`claude` 或其他 executor；仅补充实时阶段、耗时、Token、输出和取消动作。
- CLI 日志读取与取消必须携带当前父会话能力；调用方传入会话树范围不等于授权，省略或伪造 sessions 不扩大可见性。唯一的归属者是任务自己的 CLI 子会话（会话 id 固定为 `cli-<taskId>`，由任务 id 推导）：子代理会话页以该身份读回本轮任务与续发是合法的，而这个 id 不可能指向别人的任务。
- 原生子代理通过宿主会话导航打开，外部任务不尝试打开不存在的会话。
- CLI 任务**不登记进宿主 jobs 服务**（与 dsh 原生子代理一致）：不会在「后台任务」里多出一条卡片，取消与日志只走本看板卡片和 `/plugin/dsh-maestro-codex/task-*` 路由。
- 后台作业按 `job.owner` 过滤，观察保留输出不消费模型自己的输出游标。抽屉里的「N 个后台任务」只数看板**主会话**名册：宿主自己的子代理作业不进那里，CLI 子智能体会话里注册的 bash 作业同样属于它们自己的会话，不并入这个数字——与内核会话顶部自己的「N 个后台任务」口径一致（`Board.tsx` 的 `jobsScope` 只传 `rootId`）。

已结束/空闲聚合与树折叠沿用原版行为；聚合预览保留任务名称，运行中的后代不能被折叠隐藏。展开一个折叠组后组卡片消失，组内成员卡片自己的收起箭头升级为**整组收起**（删展开记录 + 成员重新手动折叠，见 `Board.foldNode` / `bridge.groupMemberIds`）。

## 节点命名与详情

- **节点名是任务名，输入截断是描述行**。原生子代理用目录 label（派发时的任务描述）做标题、displayTitle（截断的对话首句）降为描述；CLI 任务用 `task_name` 参数（省略时取 task 首行，`dispatch.taskNameOf`）做标题、`MaestroTaskSummary.inputPreview`（压平截 80 字）降为描述。描述画在卡片名称下方的 text 槽里，原生子代理只在原生 live 没有实时文本时填充（流式中的真实输出永远优先）。CLI 卡片名不再带 `claude cli · ` 前缀——来源 CLI 由 executor 徽标标识；external 幽灵节点仍靠目录 label 的 `cli · ` 前缀识别。
- **右上角来源标识**：每颗子智能体卡片右上角有「logo + 文字」徽标——CLI 行用 executor（claude / codex），dsh 原生子智能体借同一槽位显示 DSH（`renderBoardNodes` 借 executor 字段，vendored 文件不动）；主智能体与折叠组无标识。品牌色（Claude 赤陶橙 / Codex 绿 / DSH 蓝，亮暗各一组）与 logo（CSS mask：Claude 星芒、OpenAI 结、官方 DeepSeek 鲸鱼）由 `accent.ts` 样式表按 `data-cli-executor` 分配；徽标内的节点名颜色保持默认。
- **模式词移除**：「可续接 / 一次性」（`mode`）不再出现在卡片 chip、meta 行与详情浮层——`renderBoardNodes` 把渲染节点上的 mode 整体剥掉，`childAddress` 内的 mode 不受影响，跳转语义不变。
- **续接可见性**：有后继轮次的 CLI 卡片显示「已续接 N 轮」（replyTo 后继链长度，仅图视图）。会话页可复制 sessionRef，用于同一可信父会话的工具续接，不能借此跨父会话挂接。已创建任务的成功或失败结果都携带 taskId、phase；已取得有效引用时保留 sessionRef 和续接提示，失败仍明确为 `ok:false`。
- **词条**：看板全站用「主智能体 / 子智能体」（`copy.ts` 运行时覆盖上游 zh 字典，vendored 源文件不动）；英文无此区分，en 不变。
- **详情浮层同构**：CLI 详情与原生子代理详情同一套字段（状态 / Token 用量 / 耗时），头部同为「节点详情」；CLI、模型、开始、结束、退出码与模式行不再出现（节点徽标已标识 CLI），用量未采集时整行省略而不是显示 0。「查看会话 / 取消任务」动作保留。

## CLI 会话页（`Session.tsx`）

CLI 子代理可以建立 **one-shot DSH 记录镜像**，但该记录不是可由 DSH 执行器继续回复的普通会话。看板详情和顶部 CLI 入口优先打开右栏 `maestro-cli-chat` 对话页；缺少对应宿主侧栏能力时，CLI 入口回落到覆盖层。看板的原生子会话跳转仍只使用右栏 `subagentchat`，不以主窗口导航替代缺失能力。历史设计取舍见 [侧栏设计记录](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/docs/plan-cli-session-in-main-window.md)，其中旧方案不代表当前契约。

- **结构化对话流**：长任务默认限高，可展开；相邻正文分片合并后交给宿主 Markdown 渲染。公开 thinking 和工具参数/结果默认折叠，展开可读全文；有详情的错误也使用可展开行，只有摘要与详情都相同才去重。thinking 使用首事件 seq 作为身份，避免 final 合并正文时因块索引变化而关闭用户已展开的详情。宿主组件缺失时回落到原生 `details`。
- **多轮串成一段**：回复任务带 `replyTo`，页面按历史链展示，每轮有时间、模型、耗时与状态。`finalText` 与流式正文按相同/包含/重叠情况合并，不把最终全文重复追加成第二篇回答。
- **续发消息**：底部输入框 Enter 发送、Shift+Enter 换行，走 `POST /plugin/dsh-maestro-codex/task/reply {id, text, model?, thinking?}`。请求必须携带当前父会话的宿主 capability；地址中的 scope 和 sessions 只定位/收窄，不能授权。服务端固定原 CLI、cwd、父归属，并使用真实 sessionRef 执行 Claude `--resume` 或 Codex `exec resume`。已有会话不重复首次派发难度门槛；原 CLI 被禁用时拒绝，不能换执行器。
- **续接锚点与并发**：从链尾回退到最近一个带有效 sessionRef 的轮次。输入框在提交中、等待新任务轮询出现及运行中保持锁定；服务端同时锁定真实 `[cli, sessionRef]`，因此不同历史锚点也不能并发 resume。同一父会话的工具入口也受同一归属与锁约束。
- **模型说明**：当前会话页没有独立模型选择器，默认继承续接锚点的 DSH 模型与思考配置。`/models` 目录和服务端显式选择能力仍存在；显式 `provider::model` 必须解析到该 DSH 供应商，裸模型名也必须在可信 DSH 供应商上解析并预检。端点缺失直接失败，不回落 CLI 用户配置。配置页选择器、服务端能力和当前回复页控件应分别描述。

## CLI 无输出保护

`timeout_minutes` 和配置页唯一的「连续无输出超时」表示连续无 stdout/stderr 输出的分钟数（1–240），不是总运行时限；该配置由 claude 与 codex 共用，不按 CLI 各存一份（旧版 `claudeTimeoutMinutes` / `codexTimeoutMinutes` 只作迁移来源，两者不同时取较大值）。非空输出分片会重置计时，包含无换行的 JSON/文本片段与 stderr；这只是可观测的无输出保护，不能判断任务是否具有语义进展。持续输出的任务不会仅因总运行时长达到 30 分钟而被杀。

预警跟随同一个 watchdog 重新排程，预警本身不刷新计时。手动取消仍立即终止进程树；探测、npm、git 等一般 `runProcess` 调用保留原来的总时限保护。没有偷偷提高默认超时或增加默认总时限。

## 用量对账与页头入口

CLI 消耗不属于父会话主模型账本。插件先在 `$DSH_HOME/maestro/usage-journal` 写 pending 标记，再保存不可变 canonical 结算记录；累计与幂等身份独立于最近 20 条展示窗口。`maestroCliUsage` 是从该账本恢复的父会话显示投影，不再把私有 `maestro/cli-usage` 事件追加到严格会话日志。列表优先读任务实际测得的 usage；未知桶保持未知，不能用 0 代替未采集。实时值与结算值分开，重试只在结算处合计。

Codex 的 `input_tokens` 是包含缓存读/写的输入。归一化为不相交的 `inputTokens = input_tokens - cached_input_tokens - cache_write_input_tokens`，与 output、cacheRead、cacheWrite 一起对账。续接前同步捕获原线程累计基线，rollout 只上报本轮差值；stdout 与 rollout 先还原原始计数再合并，不把历史累计或已归一化输入重复加入。基线缺失或计数回退时明确提示退化到 CLI 当轮用量帧，缺失值不伪造为零。成功、失败、取消及超时均保留实际已采集消耗；不会自动改写历史错误账务。

**跨插件边界**：公开 `maestroCliAccounting.read/settlements` 需要父会话能力，可读取完整账本。标准子记录用量是同笔消耗的镜像；消费方不能再把父自定义投影与子记录相加。宿主标准折叠是否接受镜像需要真实对账验证，不能仅凭插件写入成功或 `nativeUsageAccepted` 判定。父会话不在线时 canonical 记录仍保留，待公开宿主面可用后恢复显示。

## 原生记录会话（统计可见性）

每次派发在宿主里建一条**真实 dsh 子会话**（`src/child-session.ts`，`origin: 'subagent'`、`parentSession` 指向派发会话、id `cli-<taskId>`），让 CLI 子代理的数据进入统计类插件已经在读的标准通道：

- **开始**：以任务全文写入一条 `user/message`，在父会话追加宿主原生 `subagent/catalog` 行（`version: 0`、`mode: 'one-shot'`、label 为任务名）。CLI 记录只用于查看和标准统计；续接必须回到 Maestro 的原 CLI 入口，不能交给普通 DSH 执行器。
- **结算**：一条 `step/start`（统计插件的请求计数标记）+ 成功写 `assistant/message`（终文本 + usage 样本，`message.source = {kind: 'model', provider, model}` 供模型归因）/ 失败写 `assistant/attempt`（宿主对未提交调用的分区边界，同样携带已消耗用量）。usage 样本四桶为 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`（插件的 `cachedInputTokens` 在此映射为 `cacheReadTokens`）。
- **为什么必须换成真会话**：旧版 A2 写的是 `{version: 2, mode: 'external'}` 行，宿主 `subagentCatalog` 投影的严格 schema 只认 `one-shot / continuable / unknown` 且指向真实会话——事件先落盘后驱动投影，fold 在该 seq 上抛出且无 containment，父会话目录从此卡死（重启后 `restore` 路径更是直接抛错）。新行已按宿主同一 schema 验证通过（见 `tests/child-session.test.ts` 的键集断言）。
- **可见性验证**：记录使用公开宿主标准事件和 provider/model 归因；是否能被目标统计插件的 live 与历史回放正确读取，必须按真实版本逐层对账，不能承诺所有消费者无条件兼容。
- **降级与开关**：`recordChildSessions` 控制新任务的即时镜像；缺少所需宿主服务时显示降级，canonical 账务不丢弃。历史镜像恢复与该开关的组合需单独验证，不能把关闭即时记录等同于删除既有记录。看板与顶部入口将镜像行和 CLI 任务行去重。
- **严格历史重放**：授权能力只保存在运行时；必要私有子记录元数据显式标记 `ignorable: true`。已有日志可能需要受控离线迁移，详见 [历史恢复说明](<session-history-recovery-guide.md>)。不要手工删除聊天事件、关闭宿主校验或让代码更新自动改写历史账本。

## 降级

- 缺少 sessions：保留当前会话根节点。
- 缺少 jobs：不渲染后台任务停靠槽，画布占满剩余高度。
- 看板范围里没有后台任务：只要宿主 jobs 服务存在，停靠槽仍保留，显示“暂无后台任务” / “No background jobs”；目录就绪空态、投影错误或 CLI 列表错误不会隐藏该槽。
- 缺少原生会话打开能力：不提供无效跳转。
- 血缘环由模型的祖先访问集合剪枝。
- CLI 续接同时支持 `dispatch_cli_task(resume=sessionRef)` 与上述 GUI `/task/reply`；两者都验证父归属、执行器及真实会话链锁。

## 验证与部署（源码仓库）

```bash
node scripts/build-upstream.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node node_modules/vitest/vitest.mjs run
node scripts/clean-build.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/tsdown/dist/run.mjs
```

以上验证命令仅用于带有已安装开发依赖的源码仓库，安装包不交付开发脚本、测试或源码。仓库也可使用 `npm run typecheck`、`npm test`、`npm run build` 和 `npm run test:upstream`；`build` 先受控清理 `lib`，再生成 host 与 client，客户端单独关闭 clean 以保留刚生成的 host。本机 pnpm 的自动依赖核验可能触发 `ERR_PNPM_IGNORED_BUILDS`，可直接使用上述已安装二进制，不更改全局包管理设置。

保真测试覆盖原始 SHA-256、CSS 每条声明/选择器/主题变量等价、360px/920px 图坐标、动画、宿主 factory 与共享 React。渲染回归覆盖真实图、树、会话血缘、CLI 去重、Token 和原版后台任务抽屉。

构建完成后更新当前 profile 实际安装的客户端包，再刷新现有 DSH 页面。只有同 checkout 的 `pnpm run dev:web` watcher 在运行时才有客户端插件 HMR；普通构建不会自动刷新当前 GUI。仅客户端变更无需重启宿主，也不启动替代服务器。超时、stats 保存与任务摘要属于宿主代码：更新实际安装的 host `lib` 后，必须完整退出并重新启动桌面宿主才生效；市场插件禁用/启用不会清除旧的模块缓存，不能替代宿主重启。
