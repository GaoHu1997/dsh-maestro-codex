# 任务看板（右侧栏 tab）

## 原版移植

任务界面直接移植自 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) **0.28.2**，不再使用旧版 `dmb-*` 纵向缩进卡片。图布局、SVG 贝塞尔连线、点阵背景、卡片两段结构、深度配色、树视图、折叠控件、详情浮层、后台任务抽屉均复用原版实现。

- 图视图是真正的分层绝对定位画布；按容器宽度排布，滚轮围绕鼠标缩放，只允许从背景拖动画布。
- 保留原版缩放范围 `0.4–2`、适配可读下限 `0.78`、适配上限 `1.3`、`220ms` 布局与视口动画。
- 标题栏使用原版 36px 高度、字体、间距、分隔线和宿主 ghost 刷新按钮。
- 图/树切换、自动折叠、缩放与适配按钮保留原版位置。取消旧的独立筛选工具栏，不往原版 UI 增加设计元素。
- 使用宿主的 React 和 UI primitives，原版 `--dsw-*` 主题变量直接继承亮/暗主题。
- 核心源码与 CSS 按原始字节保存；只有 4 个渲染文件加入隔离的 CLI `executor` 字段/右对齐标识，测试移除这些精确插入后验证原始 SHA-256。源文件哈希见 [source-manifest.json](../src/client/board/upstream/source-manifest.json)，MIT 许可见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES)。CSS Modules 编译后内联进客户端包，不依赖宿主额外加载样式文件。

## 座位与数据

通过可选的 `betterSidebar.registerTab` 注册 `maestro-board`，标题「任务看板」、`order: 45`、`single: true`。没有安装 better-sidebar 时不显示看板，其余 CLI 功能不受影响。

| 数据 | 来源 | 行为 |
| --- | --- | --- |
| 会话树 | `sessions.list.byId`、血缘与 `subagentCatalog` 投影 | 向祖先找到根，合并目录与血缘，保留子代理任务描述 |
| CLI 子代理 | `/plugin/dsh-maestro-codex/tasks`、`task-detail`、`task-cancel` | 列表 2.5s、展开详情 900ms 轮询；仅读取当前会话树归属任务 |
| 用量与耗时 | `tokenUsage`、`subagentTiming`、`maestroCliUsage` | 映射进原版卡片元信息和详情 |
| 原生子代理状态 | `sidebar/api/subagents.live` | 沿用原版 3s 刷新，实时 activity / done / error 不由 CLI 状态覆盖 |
| 工作流 | `sidebar/api/workflows.list` | 沿用原版 5s 刷新、工作流卡片、成员节点与详情/导航 |
| Agent Team | `agentTeam` 投影与原生 live | 原版 TeamBoard / TaskWindow，创建与 CAS 更新复用已有 teams API |
| 后台任务 | 宿主 `jobs.state`、`watchRows`、`observe`、`kill` | 独立原版 JobsDrawer，不再使用固定占比的自绘面板 |

不新增 host 路由，不修改模型路由、难度门槛、权限或续接契约。CLI 超时保护的修正见下文。隐藏看板时停止列表/日志轮询及作业观察。看板读取原版 SidebarStore 的图/树、自动折叠和作业自动收起偏好；保留原版 `<768px` 窄屏默认树视图。

团队任务的正文、编辑控件与窗口使用原版组件。Markdown 的宿主文件导航是显式兼容适配：只有宿主提供 `openMarkdownFile` 时才打开本地 Markdown 链接，不伪造 explorer 路由或完整跨文件锚点能力。

## CLI 接入边界

[model.ts](../src/client/board/model.ts) 的 `buildSessionTree` 构建骨架，`attachRows` 按 `MaestroTaskSummary.sessionId` 挂接 CLI 节点：

- id 为 `cli:<taskId>`，避免与原生会话 id 冲突。
- 树外归属任务丢弃；无归属安装任务保持既有可见语义。
- 对应 CLI 目录幽灵节点去重，不伪造可打开的本地会话。
- CLI 仍使用原版代理卡片，身份栏/树标题右侧明确标识 `codex`、`claude` 或其他 executor；仅补充实时阶段、耗时、Token、输出和取消动作。
- CLI 日志读取与取消始终传会话树范围，不泄漏其他会话任务。
- 原生子代理通过宿主会话导航打开，外部任务不尝试打开不存在的会话。
- CLI 任务**不登记进宿主 jobs 服务**（与 dsh 原生子代理一致）：不会在「后台任务」里多出一条卡片，取消与日志只走本看板卡片和 `/plugin/dsh-maestro-codex/task-*` 路由。
- 后台作业按 `job.owner` 过滤，观察保留输出不消费模型自己的输出游标。

已结束/空闲聚合与树折叠沿用原版行为；聚合预览保留任务名称，运行中的后代不能被折叠隐藏。

## CLI 无输出保护

`timeout_minutes` 和配置页的 CLI 超时现在表示连续无 stdout/stderr 输出的分钟数（1–240），不是总运行时限。非空输出分片会重置计时，包含无换行的 JSON/文本片段与 stderr；这只是可观测的无输出保护，不能判断任务是否具有语义进展。持续输出的任务不会仅因总运行时长达到 30 分钟而被杀。

预警跟随同一个 watchdog 重新排程，预警本身不刷新计时。手动取消仍立即终止进程树；探测、npm、git 等一般 `runProcess` 调用保留原来的总时限保护。没有偷偷提高默认超时或增加默认总时限。

## 用量对账与页头入口

CLI 请求不属于 DSH 主模型账本。每次派发结算后 `reportCliUsage` 在所属会话追加 `maestro/cli-usage` 事件，`maestroCliUsage` projection 累积四类 Token、耗时与最近 20 条调用记录。任务树和顶部子智能体列表优先读取任务摘要的已测量 `usage`，投影记录仅作为兼容回退，不再被最近 20 条记录的上限截断。运行中的调用会先显示实时用量：通道每收到一帧带用量的输出（claude 每帧、codex 每轮）就写进任务的 `liveStats`，看板按 2.5 秒轮询刷新，结算后 `stats` 接替并显示整轮精确值；两者分开暂存，重试累加只发生在结算值上，不会把实时值算重。尚未收到任何用量时显示“尚未收到用量”，已结束且没有测量值时明确显示“未采集”，不把未知当成真实零消耗。

失败、超时、取消也保存通道已经收到的 stats；重试的各次请求用量相加，非用量元数据保留最近一次。Codex 的 inclusive input 先扣除缓存读，再进入统一的非缓存输入桶，不能把缓存读重复加回。未从 stdout 收到的用量不能凭空还原；历史任务不会自动补账，也不会自动读取原生会话日志或续接。

不用 `assistant/message` 或 `assistant/attempt` 替代事件，避免污染主会话 surface 或覆盖主模型用量。配置页「任务监视」与近 7 天统计继续使用同一投影。

会话页头的 `maestro-cli-catalog` chip 保持原有逻辑：有 CLI 任务时合并本地子代理与 CLI 计数，并显示 CLI 阶段、耗时和用量；没有 CLI 时仍使用内核入口。外部目录行仅在派发开始时记录一次，任务状态来自本插件实时列表，不伪造本地子会话。

## 降级

- 缺少 sessions：保留当前会话根节点。
- 缺少 jobs：不渲染后台任务抽屉，画布占剩余空间。
- 缺少原生会话打开能力：不提供无效跳转。
- 血缘环由模型的祖先访问集合剪枝。
- 已有 CLI 续接仍通过 `dispatch_cli_task` 的 `resume=sessionRef`，不另造 GUI 续接接口。

## 验证与部署

```bash
node scripts/build-upstream.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/tsdown/dist/run.mjs
```

也可使用包内 `typecheck`、`test`、`build` 和 `test:upstream` 脚本；本机 pnpm 的自动依赖核验可能触发 `ERR_PNPM_IGNORED_BUILDS`，可直接使用上述已安装二进制，不更改全局包管理设置。

保真测试覆盖原始 SHA-256、CSS 每条声明/选择器/主题变量等价、360px/920px 图坐标、动画、宿主 factory 与共享 React。渲染回归覆盖真实图、树、会话血缘、CLI 去重、Token 和原版后台任务抽屉。

构建完成后更新当前 profile 实际安装的客户端包，再刷新现有 DSH 页面。只有同 checkout 的 `pnpm run dev:web` watcher 在运行时才有客户端插件 HMR；普通构建不会自动刷新当前 GUI。仅客户端变更无需重启宿主，也不启动替代服务器。超时、stats 保存与任务摘要属于宿主代码：更新实际安装的 host `lib` 后，必须完整退出并重新启动桌面宿主才生效；市场插件禁用/启用不会清除旧的模块缓存，不能替代宿主重启。
