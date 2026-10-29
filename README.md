# dsh-maestro-codex

[![npm](https://img.shields.io/npm/v/dsh-maestro-codex?logo=npm)](https://www.npmjs.com/package/dsh-maestro-codex)
[![release](https://github.com/GaoHu1997/dsh-maestro-codex/actions/workflows/release.yml/badge.svg)](https://github.com/GaoHu1997/dsh-maestro-codex/actions/workflows/release.yml)
[![license](https://img.shields.io/npm/l/dsh-maestro-codex)](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/LICENSE)

dsh 的 CLI 子代理编排插件：把会话中的任务按类型派发给 **codex cli** 或 **claude cli**（headless）执行，取回结果回填主会话。

## 能力

- **dispatch 工具**：在主会话注册 `dispatch_cli_task` 工具，主代理先评估任务难度并给出理由，达到配置门槛才派发，未达门槛直接完成，不启动 CLI。
- **独立难度门槛**：在「CLI 管理」展开 Claude / Codex，各自选择低 / 中 / 高 / 极高（默认中），即时生效，互不影响；未单独设置时兼容沿用旧的统一门槛。调用工具传 `task_difficulty`（`low / medium / high / extreme`）与 `difficulty_reason`，按实际选定 CLI 的门槛校验，不改选门槛更低的 CLI 绕过限制。旧调用未评估按低处理，显式指定 `cli` 也不能绕过门槛。低：问答、查询、局部编辑；中：常规多步骤任务；高：跨模块重构、复杂调试；极高：系统级设计或迁移。难度由主代理评估，类型关键词只负责选择 CLI，不抬高任务难度。
- **路由表**：配置页以卡片点选为每个 CLI 配置任务类型（如"需求分析/代码审查 → claude，代码生成/数据处理 → codex"）与默认 CLI。
- **权限配置**：claude 支持 `default / acceptEdits / plan / bypassPermissions`（`继承` = 使用 CLI 非交互默认策略）；codex 通过沙箱（`read-only / workspace-write / danger-full-access`）划界。API 地址、Token、CLI 路径、超时等收在「高级连接设置」里，默认折叠。
- **模型配置（dsh 目录直选）**：配置页的「dsh 模型」下拉直接列出 dsh 中已配置的供应商与模型（读取 llm-pi-ai 设置 + credentials 密钥）。选中后插件自动把端点/密钥/模型注入 CLI——codex 经 `-c` 合成 model_provider（仅 openai-responses 协议，codex 0.146+ 已移除 chat 支持），claude 经 ANTHROPIC_BASE_URL/AUTH_TOKEN（仅 anthropic-messages 协议）。**默认沿用主代理当前选择的模型**（协议不支持该 CLI 时自动回退配置页的选择）；工具参数显式指定模型时以参数为准；都没选则用 CLI 自身默认模型。
- **CLI 管理**：配置页检测版本、按版本安装/卸载（npm -g：`@anthropic-ai/claude-code`、`@openai/codex`），版本列表只列正式版并标注当前平台，支持自定义 registry。
- **任务监视**：只记录 `dispatch_cli_task` 派发的子代理任务（带 CLI 徽标，与主会话自己执行的工作区分开）；进度事件流、取消、超时（每 CLI 可配）、并发上限。
- **任务看板**：装了 [dsh-better-sidebar](https://github.com/GaoHu1997/dsh-better-sidebar) 时，右侧栏多一个「任务看板」tab，把 **DSH 主任务 / 子代理树 / CLI 子代理 / 后台任务** 四路数据摊在同一页：运行状态点、子代理跳转、CLI 任务实时日志与取消、后台作业输出与终止，顶部「全部 / 运行中 / 已结束 / 失败」筛选带计数。CLI 任务与会话树隔离——只显示当前会话及其子会话派发的任务（配置页安装 CLI 的 npm 任务不属于任何会话，始终可见）。数据全部来自客户端已有 feed（`ctx.sessions.list`、`ctx.jobs`、本插件的 `/tasks` 路由），不额外增加 host 侧接口。
- **用量与请求记录**：每次 CLI 调用结束（成功、失败都算）向所属会话追加一条 `maestro/cli-usage` 事件，并注册同名 session projection（`maestroCliUsage`）。dsh 与其他插件可从 `projectionsBySession[sessionId].values.maestroCliUsage` 读到累计请求数、输入/输出/缓存 token、总耗时与最近 20 次调用的明细（CLI、模型、阶段、退出码、token、错误）。不伪造 `assistant/message`，所以不会污染对话 surface，也不会改写主模型的用量账本。

## 执行方式

- claude：`claude -p --output-format stream-json --verbose`，任务文本走 stdin。
- codex：`codex exec --json --skip-git-repo-check -`，任务文本走 stdin。

## 开发

```bash
pnpm install
pnpm build      # tsc（host 半）+ tsdown（client 半 → lib/client.js）
pnpm test       # vitest
```

安装到 dsh：在 dsh 插件市场或插件管理器安装本包；`cordis.patch.yml` 会把 `dsh-maestro-codex` 条目插入 profile。

## 参考

设计调研了 [jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) 的 ai-bridge 多 CLI 通道抽象（claude stream-json / codex app-server）。
