# dsh-maestro-codex

[![npm](https://img.shields.io/npm/v/dsh-maestro-codex?logo=npm)](https://www.npmjs.com/package/dsh-maestro-codex)
[![release](https://github.com/GaoHu1997/dsh-maestro-codex/actions/workflows/release.yml/badge.svg)](https://github.com/GaoHu1997/dsh-maestro-codex/actions/workflows/release.yml)
[![license](https://img.shields.io/npm/l/dsh-maestro-codex)](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/LICENSE)

dsh 的 CLI 子代理编排插件：把会话中的任务按类型派发给 **codex cli** 或 **claude cli**（headless）执行，取回结果回填主会话。

## 能力

- **dispatch 工具**：在主会话注册 `dispatch_cli_task` 工具，派发前由主代理先判断该任务是否需要开子代理——不需要就自己完成；需要时再评估任务难度并给出理由，达到配置门槛才派发，未达门槛改用 dsh 子代理（`subagent` / `subagent_fork`），不启动 CLI。
- **独立难度门槛**：在「CLI 管理」展开 Claude / Codex，各自选择低 / 中 / 高 / 极高（默认中），即时生效，互不影响；未单独设置时兼容沿用旧的统一门槛。调用工具传 `task_difficulty`（`low / medium / high / extreme`）与 `difficulty_reason`，按实际选定 CLI 的门槛校验，不改选门槛更低的 CLI 绕过限制。旧调用未评估按低处理，显式指定 `cli` 也不能绕过门槛。低：问答、查询、局部编辑；中：常规多步骤任务；高：跨模块重构、复杂调试；极高：系统级设计或迁移。难度由主代理评估，类型关键词只负责选择 CLI，不抬高任务难度。
- **路由表**：配置页以卡片点选为每个 CLI 配置任务类型（如"需求分析/代码审查 → claude，代码生成/数据处理 → codex"）与默认 CLI。
- **权限配置**：claude 支持 `default / acceptEdits / plan / bypassPermissions`（`继承` = 使用 CLI 非交互默认策略）；codex 通过沙箱（`read-only / workspace-write / danger-full-access`）划界。API 地址、Token、CLI 路径、超时等收在「高级连接设置」里，默认折叠。
- **模型配置（dsh 目录直选）**：配置页的「dsh 模型」下拉直接列出 dsh 中已配置的供应商与模型（读取 llm-pi-ai 设置 + credentials 密钥）。选中后插件自动把端点/密钥/模型注入 CLI——codex 经 `-c` 合成 model_provider（OpenAI 兼容供应商，`openai-responses` 与 `openai-completions` 都可选，统一按 responses 方言驱动；codex 0.146+ 已移除 chat 支持），claude 经 ANTHROPIC_BASE_URL/AUTH_TOKEN（仅 anthropic-messages 协议），并把同一组变量写进一次性的 `--settings` 文件——Claude Code 会用它自己 settings 文件里的 `env` 块覆盖进程环境变量；只设进程 env 时，用户 `~/.claude/settings.json` 里残留的网关会静默顶替配置页的选择（旧网关失效时整轮任务直接 403）。**默认沿用主代理当前选择的模型**（协议不支持该 CLI 时改用配置页的选择）；工具参数显式指定模型时以参数为准。两者都拿不到可用端点时任务**直接失败并列出原因**（例如主代理是 anthropic-messages 协议却派给 codex + 配置页没选模型），不会回落到 CLI 自身配置文件里的模型——那是另一套供应商与密钥。codex 在注入 dsh 端点时以 `--ignore-user-config` 运行，用户自己的 `~/.codex/config.toml`（自带 model/model_provider、`model_instructions_file`、notify、插件与 MCP 服务器）不再参与派发的任务；被一起甩掉的 `[windows] sandbox` 由插件补回（Windows 上重新声明 `windows.sandbox="elevated"`，否则 codex 会拒绝执行任何命令，子代理连文件都读不到）。真正 spawn 之前还有一道**模型预检**：协议不匹配的候选直接跳过；端点不接受该模型名时（供应商没声明这个模型，或探针返回 404）当场报出是哪家供应商、哪个模型，不再让 CLI 跑到一半才失败；预检只是 1-token 的最小请求，连不通时记为「无法判定」仍然照常派发。
- **思考等级**：档位**来自所选 dsh 模型自身配置的 `reasoningEfforts`**（llm-pi-ai 模型条目），不写死——选了模型，思考等级下拉就列该模型声明的档位（如 off / low / medium / high）；未选模型或模型未声明时只能保持默认。claude 经 `MAX_THINKING_TOKENS` 传参（off/none→0，low/medium/high→4k/10k/32k，未映射的档位忽略）；codex 经 `-c model_reasoning_effort` 原样传参（codex 不认的档位如 off 自动跳过），与「-c 覆盖项」同时设置时覆盖项优先。
- **CLI 管理**：配置页检测版本、按版本安装/卸载（npm -g：`@anthropic-ai/claude-code`、`@openai/codex`），版本列表只列正式版并标注当前平台，支持自定义 registry。
- **任务监视**：只记录 `dispatch_cli_task` 派发的子代理任务（带 CLI 徽标，与主会话自己执行的工作区分开）；进度事件流、取消、超时（每 CLI 可配）、并发上限。
- **任务看板**：装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 时，右侧栏多一个「任务看板」tab。直接移植该项目 **0.28.2 原版任务管理**：真实分层图、SVG 曲线、点阵背景、缩放/拖动/适配、图/树切换、两段式卡片、自动折叠、原版详情浮层与后台任务抽屉，源码与 CSS 有逐字节/等价测试。仅在数据桥接层加入 CLI 子代理：按所属会话挂接、外部目录去重、阶段/耗时/Token/转录/取消，继续使用既有路由；不再使用旧的纵向缩进图与额外筛选栏。页头 CLI chip、`maestroCliUsage` 用量投影、会话隔离和后台作业输出游标语义保持不变。详见 [任务板说明](docs/task-board.md)。
- **用量与请求记录**：每次 CLI 调用结束（成功、失败都算）向所属会话追加一条 `maestro/cli-usage` 事件，并注册同名 session projection（`maestroCliUsage`）。dsh 与其他插件可从 `projectionsBySession[sessionId].values.maestroCliUsage` 读到累计请求数、输入/输出/缓存 token、总耗时与最近 20 次调用的明细（CLI、模型、阶段、退出码、token、错误）。任务还没结束时，看板上的 CLI 卡片已经能显示实时消耗——claude 每帧都带用量、codex 每轮更新一次，按 2.5 秒轮询刷新，结算后换成整轮的精确值（实时值与结算值分开暂存，不会把重试的用量算重）。配置页「任务监视」顶部有按此折出的**近 7 天用量统计**（调用/成功/失败、四类 token、总耗时、按 CLI 分布、最近调用）。不伪造 `assistant/message`，所以不会污染对话 surface，也不会改写主模型的用量账本。
- **任务结果落盘**：每次派发结算后，把任务摘要、最终文本与事件尾（最近 200 条）写入 `$DSH_HOME/maestro/tasks/<taskId>.json`（最多保留 200 条，可在「调度设置」关闭）。插件启动时把最近 40 条读回来种进任务表——重启后「任务监视」仍能翻看历史结果与转录。
- **会话续接（resume）**：工具支持 `resume` 参数，传上次结果里的 sessionRef（claude 的 session id / codex 的 thread id），同一次协作可以在原会话上多轮往返（claude `--resume`、codex `exec resume`）；原会话对话不会自动带入，需要的结论要写进 task。
- **拓扑可见，不进后台任务**：派发一开始就往父会话补一行 `mode: external` 的子代理目录（不等结束），内核会话顶部的「N 个子智能体」下拉框与看板拓扑树里立刻多一个节点。CLI 任务**刻意不登记进 dsh 的后台任务**——dsh 自己的子代理不出现在那里，CLI 子代理照同样方式处理，避免同一个任务有两份状态、两条终止入口；阶段、耗时、实时用量、转录与取消都在本插件的任务看板卡片上。
- **派发上下文与韧性**：派发前可自动把 cwd 的 git 工作区快照（分支/未提交改动，只读）拼进任务开头（`injectGitContext`，默认开）；CLI 超时指连续无 stdout/stderr 非空输出分片的时长（`timeout_minutes`，1–240 分钟，不是总运行时长），每个真实输出分片重置计时；这是无输出保护，不判断任务语义进展。无输出窗口剩余约 1/5（至多 2 分钟）时在事件流预警，恢复输出也重置预警；版本检测、npm 等一般进程仍按总时长超时；普通失败可配置自动重试（`failureRetries`，0–2，默认 0——会改文件的任务建议保持 0，超时与手动取消永不重试）。

## 执行方式

- claude：`claude -p --output-format stream-json --verbose`，任务文本走 stdin；`resume` 时追加 `--resume <sessionId>`。
- codex：`codex exec --json --skip-git-repo-check --ignore-user-config -`，任务文本走 stdin；`resume` 时为 `codex exec resume <threadId> --json …`，续接指令同样走 stdin。

## 开发

```bash
pnpm install
pnpm build      # tsc（host 半）+ tsdown（client 半 → lib/client.js）
pnpm test       # vitest
```

安装到 dsh：在 dsh 插件市场或插件管理器安装本包；`cordis.patch.yml` 会把 `dsh-maestro-codex` 条目插入 profile。

## 参考

设计调研了 [jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) 的 ai-bridge 多 CLI 通道抽象（claude stream-json / codex app-server）。
