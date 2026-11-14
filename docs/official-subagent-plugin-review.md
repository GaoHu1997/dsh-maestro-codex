# DSH 官方 Codex / Claude Code 子代理插件借鉴报告

> 生成时间：2026-11-14  
> 对象：`@deepseek-ai/dsh-subagent-codex`、`@deepseek-ai/dsh-subagent-claude-code`  
> 对照项目：`dsh-maestro-codex` v0.1.17（当前工作区 `D:\github\dsk-plugin\dsh-maestro-codex`）  
> 当前 DSH 安装：`0.2.2-rc.3`；官方插件基准：`0.2.2-rc.3`。  
> 说明：本次仅下载并解包 npm tarball 到本机 `.tmp/official-plugins/` 作只读核验，未安装、启用或修改任何 Profile/插件状态，也未改动本仓库运行代码。

---

## 0. 结论先行

**不建议把官方两个插件直接替换为本项目的主执行后端，也不建议低风险地「切到 `ctx.subagents` / `ctx.subprocess` seam」。** 两者不是同一产品形态：

- 官方插件是 **Host 管理的一次性外部 activation provider**：每个 bundle 注册一个固定 provider 和一个全局 `subagent_codex` / `subagent_claude_code` 工具；工具先返回子任务名称，运行时稍后发完成通知；只回最终答案或安全失败诊断，不保留产品会话、不支持续接、进度流、用量、桥接工具、动态模型选择或 UI 看板。
- `dsh-maestro-codex` 是 **完整的 CLI 编排器**：`dispatch_cli_task` 同步返回结构化 `DispatchValue`；自带路由、难度门槛、dedupe、resume、DSH 模型注入与预检、技能/宿主工具/MCP 桥、用量账本、健康看板、任务看板、CLI 安装管理、进度事件流、恢复与持久化。

直接替换会越过当前 `dispatch_cli_task → runDispatch → channels/* → spawn.ts` 主链路，导致 resume、Grok、动态模型、dsh_bridge、用量账本、任务面板、安装管理、无输出超时等能力整体丢失。

**真正值得吸收的是官方的「工程边界」而不是执行后端**：

1. **统一终态结果契约**：严格 terminal event / strict success / 空答案失败 / 统一 stopReason。
2. **安全诊断与信息边界**：固定 `stage + category + outcome + httpStatus`，原始错误留在 cause/Host log，模型侧只拿裁剪后的安全诊断；stderr 不回主会话。
3. **发布边界与资源所有权**：未就绪不发布；发布后 result 永不 reject；dispose 幂等；进程树 quiescence；result 与 cleanup 失败分离。
4. **环境 scrub / explicit opt-in 与 cwd 可进入校验**：子进程默认不继承凭证形环境变量，显式 `env` 才允许密钥进入；cwd 必须绝对、存在、可进入。
5. **可选、只读的 seam 能力探针**：把官方 seam 加入 `/overview` 能力报告即可，不注册 provider、不改 dispatch。

一句话：**官方插件是「最小可信外部 provider」的范式，本项目是「富功能 CLI orchestrator」；保留自有主链路，抽取官方的终态、诊断、安全与清理规范。**

---

## 1. 核验基准与方法

### 1.1 当前环境

- 当前 DSH CLI manifest 版本：`0.2.2-rc.3`。
- 安装版共享包：
  - `@deepseek-ai/dsh-subagent@0.2.2-rc.3`
  - `@deepseek-ai/dsh-subprocess@0.2.2-rc.3`
  - `@deepseek-ai/dsh-tool-subagent@0.2.2-rc.3`
  - `@deepseek-ai/dsh-sdk-protocol@0.2.2-rc.3`
  - `@deepseek-ai/dsh-timeout@0.2.2-rc.3`
- Plugin Manager 观察：
  - `@deepseek-ai/dsh-subagent-codex@0.2.2-rc.3`：`installed: true`、`enabled: false`。
  - `@deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.3`：`availability: missing`、`installed: false`、`enabled: false`。
- 本次没有安装或启用官方插件，也没有修改 profile。

### 1.2 官方包来源

- npm registry 查询显示两个包均有 `0.0.1-rc.1` 到 `0.2.2-rc.3` 的版本序列；`0.2.2-rc.3` 发布时间为 2026-11-13。
- 本报告以 `npm pack @deepseek-ai/dsh-subagent-codex@0.2.2-rc.3` 与 `npm pack @deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.3` 得到的 tarball 为准。
- 解包目录（本机临时，`.tmp/` 已被 `.gitignore` 忽略）：
  - `.tmp/official-plugins/latest/codex/package/`
  - `.tmp/official-plugins/latest/claude/package/`
- `0.0.1-rc.1` 也下载核验，仅用于梳理版本演进，不作为当前官方能力结论。

### 1.3 路径缩写

为避免报告过长，下文使用这些缩写：

| 缩写 | 含义 |
|---|---|
| `CX/` | `.tmp/official-plugins/latest/codex/package/` |
| `CL/` | `.tmp/official-plugins/latest/claude/package/` |
| `SEAM/` | 安装版 `D:\devlop\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-subagent\` |
| `SUBPROC/` | 安装版 `...\@deepseek-ai\dsh-subprocess\` |
| `TOOL/` | 安装版 `...\@deepseek-ai\dsh-tool-subagent\` |
| `M/` | 本仓库 `src/` |

本仓库证据使用 `路径:行号`；官方包证据使用 `CX/src/...:行号` / `CL/src/...:行号`；安装版 seam 使用 `SEAM/src/...:行号`。

---

## 2. 官方插件到底是什么

### 2.1 发布形态：从 provider-only 到 Profile Bundle

`0.0.1-rc.1` 时，两个包还只是 provider：`publishConfig.access: restricted`，README 让用户在 profile 中手工插入 provider 行和 `dsh-tool-subagent` 工具行，且工具默认 `disabled: true`；生产环境依赖宿主 `PATH` 上的 `codex` / `claude`。

`0.2.2-rc.3` 已变成标准官方 bundle：

| 主题 | `0.0.1-rc.1` | `0.2.2-rc.3` | 证据 |
|---|---|---|---|
| 发布 | restricted、仅 `lib` | public、含 `src`、`locale`、`cordis.patch.yml`、icon、map | `CX/package.json:4-35`；`CL/package.json:4-35` |
| 装载 | 手工插入 provider/tool 行 | `dsh.bundle.patch` 自动 insert provider + 全局工具 | `CX/package.json:37-40`；`CX/cordis.patch.yml:1-9`；`CL/cordis.patch.yml:1-9` |
| 配置 | `env`、`disposeGraceMs` | 增加 `providerName`、`model`、`permissionMode` | `CX/src/index.ts:35-59`；`CL/src/index.ts:38-66` |
| 产品载荷 | 依赖宿主 PATH | 固定依赖包内产品载荷，不回退宿主 CLI | `CX/package.json:50-55`；`CL/package.json:50-57`；`CX/src/run.ts:44-53`；`CL/README.zh.md:56,83,173` |
| 诊断 | 较裸的启动/协议错误 | 固定 stage/category/outcome/httpStatus，安全失败事实 | `CX/src/run.ts:71-129`；`CL/src/run.ts:62-136` |
| 协议基线 | Codex 0.147.0 / SDK 0.3.220 | Codex 0.153.4 / SDK 0.3.263 | `CX/src/wire.ts:1-5`；`CX/package.json:54`；`CL/package.json:51` |

Bundle patch 的形态很简洁：

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: codex
        toolName: subagent_codex
        maxDepth: provider-managed
```

证据：`CX/cordis.patch.yml:1-9`；Claude 对应 `CL/cordis.patch.yml:1-9`。启用后所有 Agent 都看见全局工具，但实际委派前不启动产品进程：`CX/README.zh.md:30-36`、`CL/README.zh.md:30-36`。

### 2.2 架构分层

两个 plugin 的结构高度对称：

| 层 | Codex | Claude Code | 职责 |
|---|---|---|---|
| `index.ts` | `CX/src/index.ts:30-130` | `CL/src/index.ts:30-147` | Config schema、provider 注册、cwd 校验、logger |
| `run.ts` | `CX/src/run.ts:225-438` | `CL/src/run.ts:385-586` | 运行生命周期、发布边界、取消、结果 settlement、dispose |
| `wire.ts` | `CX/src/wire.ts:192-711` | — | 最小 app-server JSON-RPC、thread/turn 关联、审批、答案选择 |
| `process.ts` | — | `CL/src/process.ts:25-159` | SDK `SpawnOptions` → `ctx.subprocess` 投影 |
| `cordis.patch.yml` | `CX/cordis.patch.yml:1-9` | `CL/cordis.patch.yml:1-9` | provider + 全局工具 |
| `locale/*.json` | `CX/locale/zh.json:2-5` | `CL/locale/zh.json:2-5` | 插件页标题与描述 |

共享 seam 的契约：

- `ctx.subagents.registerProvider(...)`：`CX/src/index.ts:107-129`、`CL/src/index.ts:123-145`。
- `NO_START_CAPABILITIES`：`SEAM/src/out-of-process.ts:50-61`，四个能力 `agentOptions / agentPreset / outputSchema / depthLimit` 全为 false。
- `assertUsableCwd`：要求 child cwd 绝对、存在且可进入：`SEAM/src/out-of-process.ts:94-112`。
- `settleRunResult`：发布后 `result` 永不 reject，取消赢竞态，错误 flatten 为 `error`，diagnostic 限 4096 UTF-8 bytes，finally 移除 abort listener：`SEAM/src/out-of-process.ts:141-178`。
- `subprocessRunHandle`：`dispose()` 幂等，取消后等待 teardown：`SEAM/src/out-of-process.ts:196-216`。
- `ctx.subprocess` 环境默认清理凭证形名称与 `DSH_*`，显式 `env` 后叠加：`SUBPROC/src/index.ts:47-87`、`SUBPROC/README.md:78-84`。

### 2.3 配置面

Codex（`CX/README.zh.md:40-54`、`CX/src/index.ts:35-59`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `providerName` | `codex` | `ctx.subagents` 注册名 |
| `model` | 省略 | 原样传给 `thread/start`，不发现别名，不设置 `modelProvider` / `serviceTier` / fallback |
| `env` | `{}` | 叠加在 scrubbed 父环境之上 |
| `permissionMode` | `never` | `never` / `approve-for-me` / `dangerously-bypass-approvals-and-sandbox` |
| `disposeGraceMs` | `3000` | managed-range 终止层级宽限 |

Claude（`CL/README.zh.md:40-56`、`CL/src/index.ts:38-66`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `providerName` | `claude-code` | `ctx.subagents` 注册名 |
| `model` | 省略 | 原样传给 SDK，省略则保留原生模型 |
| `env` | `{}` | 叠加在 scrubbed 父环境之上 |
| `permissionMode` | `dontAsk` | `dontAsk` / `acceptEdits` / `auto` / `plan` / `bypassPermissions` |
| `disposeGraceMs` | `3000` | managed-range 终止层级宽限 |

关键限制：这些是 **Profile 静态实例配置**，调用时不能动态选择 provider/model：`CX/README.zh.md:168`、`CL/README.zh.md:170`。

### 2.4 运行生命周期

#### Codex

1. 只接受非空 `text` blocks：`CX/src/run.ts:167-182`。
2. 已取消则拒绝启动：`CX/src/run.ts:229-232`。
3. 从 `@openai/codex/package.json` 的 `bin.codex` 解析包内 wrapper，固定 argv 为 `process.execPath <wrapper> app-server --stdio`：`CX/src/run.ts:44-53,131-137`。
4. `ctx.subprocess.spawn({ argv, cwd, stdio, graceMs, env })`：`CX/src/run.ts:234-248`。
5. `initialize → initialized → flush`：`CX/src/wire.ts:268-281`。
6. `thread/start { cwd, ephemeral: true, model?, permission... }`，必须返回 `ephemeral === true`：`CX/src/wire.ts:289-302`。
7. 只有握手与 thread 创建成功后才发布 `SubagentRun`：`CX/src/run.ts:315-354,380-438`。
8. `turn/start` 提交文本任务，等权威 `turn/completed`：`CX/src/wire.ts:311-344,685-710`。
9. 答案优先级 `final_answer` > `partial_answer` > `phase: null`；`commentary` 忽略，未知 phase 失败；完成但无非空白答案也失败：`CX/src/wire.ts:389-400,665-682,369-374`。
10. `contextWindowExceeded` 唯一映射 `max-tokens`：`CX/src/wire.ts:123-124,363-365`。

#### Claude Code

1. 只接受非空 `text` blocks 并 `join('')`：`CL/src/run.ts:184-199`。
2. 创建私有 `AbortController`：`CL/src/run.ts:394-401`。
3. 调 SDK `query({ prompt, options })`，仅在 `spawnClaudeCodeProcess` 同步提供由 `ctx.subprocess` 管理的 child 后才发布：`CL/src/run.ts:441-459`。
4. `options` 固定 `persistSession:false`、禁用 `AskUserQuestion`、设置 `permissionMode`、无人值守 deny/decline/cancel 回调、custom spawn：`CL/src/run.ts:316-377`。
5. 完整迭代消息流，只接受 `type:'result' && subtype:'success' && !is_error && result.trim() !== ''`，且要求 iterator 正常结束：`CL/src/run.ts:206-261`。
6. 失败按 SDK subtype 映射为 `limit / product-error / invalid-result / unknown`：`CL/src/run.ts:111-124,538-560`。

### 2.5 协议与无人值守边界

Codex wire 只实现 app-server 所需最小方法：

- 请求：`initialize`、`thread/start`、`turn/start`、`turn/interrupt`。
- server request：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`。
- notification：`turn/started`、`item/completed`、`turn/completed`。
- 证据：`CX/src/wire.ts:268-302,311-387,574-627,635-710`。

审批决策：

- command/file approval：优先 `cancel`，否则 `decline`；稳定旧协议无决策列表则回落 `decline`。
- permission grant：返回空 turn-scoped permissions。
- user input：返回空 answers。
- MCP elicitation：decline。
- 未知 server request：fail closed。
- 证据：`CX/src/wire.ts:59-67,574-627`。

Claude 无人值守：

- `disallowedTools` 至少包含 `AskUserQuestion`，`plan` 还禁用 `ExitPlanMode`。
- 非 `bypassPermissions` 时 `canUseTool` 一律 deny。
- `onElicitation` decline，`onUserDialog` cancelled。
- `supportedDialogKinds` 只包含 `refusal_fallback_prompt`。
- 证据：`CL/src/run.ts:58-60,316-377`。

### 2.6 安全诊断与信息边界

官方把「可给模型/父 Session 的诊断」压缩成固定安全事实：

- Codex facts：`initialize / thread-start / turn-start / turn / process / teardown` × `limit / access-policy / service / transport / product-error / invalid-result / unknown / process`，可带 HTTP status、exit code、signal：`CX/src/run.ts:71-104`、`CX/src/wire.ts:18-30`。
- Claude facts：`query-start / query-run / process / teardown` × `limit / product-error / invalid-result / process / unknown`：`CL/src/run.ts:62-95,111-124,538-560`。
- 原始错误留在 `Error.cause` 或 Host logger；对模型只暴露 provider-authored diagnostic：`CX/src/run.ts:106-129`、`CL/src/run.ts:98-136`、`CL/src/index.ts:107-111`。
- diagnostic 限 4096 UTF-8 bytes，且不得包含 tool inputs、文件内容、环境值、凭证、raw payload：`SEAM/src/types.ts:277-285`、`SEAM/src/out-of-process.ts:18-48`。
- Codex stderr 同步转发到 Host stderr，不进父 Session；Claude stderr `inherit`：`CX/src/run.ts:256-281`、`CL/src/process.ts:46-60`。
- 父模型只见选择答案或 stopReason + 安全诊断；推理、中间消息、工具通信、用量、stderr、工作区差异、产品 ID、命令、路径、原始协议载荷不复制：`CX/README.zh.md:150,173`、`CL/README.zh.md:152,175`。

---

## 3. 官方明确没有、而本项目已有的能力

| 能力 | 官方 0.2.2-rc.3 | 本项目现状 | 判断 |
|---|---|---|---|
| resume / 续接 | 无；Codex `ephemeral:true`，Claude `persistSession:false`，文档明示不支持 | `resume`、`sessionRef`、`/task/reply`、Claude `--resume`、Codex `exec resume`、Grok `-r` | 本项目显著更完整 |
| 动态路由 / 难度门槛 | 无；静态 provider/tool 绑定 | `pickCli`、独立最低难度、`task_difficulty`、`difficulty_reason`、停用回落、dsh 内置回退 | 本项目显著更完整 |
| 多执行器 | 两个独立 bundle，仅 Codex / Claude | Claude / Codex / Grok + 内置 dsh 回退 | 本项目更宽 |
| 动态模型选择 / DSH 模型目录 / 预检 | 无；静态 `model` 或原生设置，无发现/预检 | DSH `provider::model`、协议闸门、1-token 探针、主代理模型继承、thinking | 本项目显著更完整 |
| Grok | 无 | 有完整 channel、隔离 home、resume、bridge | 官方无对应 |
| MCP / 宿主工具 / 技能桥 | 无；elicitation 拒绝、无宿主工具桥 | `dsh_bridge`、off/auto/scoped/custom、技能两段式、12 个 scoped 文件工具 | 本项目核心能力 |
| 进度流 | 无 | 事件环、轮询、运行中用量快照、CLI 会话页 | 本项目核心能力 |
| 用量 / 账本 / 原生子记录 | 不把 usage 复制给父 Session | canonical `UsageJournal`、`maestroCliUsage`、公开 accounting、`cli-<taskId>` 镜像 | 本项目核心能力 |
| UI / 配置页 / 看板 / 诊断 | 只有 locale/icon + runtime 通知 | 配置卡、任务看板、CLI 会话页、health/status/prompts/config-history | 本项目核心能力 |
| CLI 安装/版本/registry/PATH 管理 | bundle 锁定平台载荷，不登录、不探测版本、不回退宿主 CLI | npm -g 安装/卸载、版本检测、自定义 registry、cliPath、Windows shim 保真 | 本项目核心能力 |
| 连续无输出超时 / 重连期限 / 失败重试 / 恢复 | 无真实 elapsed timeout、无副作用回滚 | idle watchdog、重连恢复期限、deadline、effects、interrupted 恢复、重试 | 本项目核心能力 |
| 结构化输出 / outputSchema | `NO_START_CAPABILITIES` 拒绝 | `MAESTRO_RESULT` 看板收尾协议（不是宿主 outputSchema） | 语义不同；官方不接受 |
| 产品会话 ID 持久化 | 无 | 保存 `sessionRef` 用于续接 | 本项目核心能力 |

本项目关键证据：

- 工具参数与输出 schema：`src/tool.ts:26-44,51-67`。
- 路由与难度门槛：`src/routing.ts:71-91,99-146`。
- `runDispatch` 主链路：`src/dispatch.ts:430-465,532-583,930-1079,1107-1188`。
- Claude `claude -p --output-format stream-json --verbose`：`src/channels/claude.ts:103-115`。
- Claude `--resume`：`src/channels/claude.ts:108-110`。
- Codex `exec --json` / `exec resume`：`src/channels/codex.ts:92-145`。
- Grok `-r` / `GROK_HOME` / MCP 隔离：`README.md:68-70`。
- `dsh_bridge` 与 scoped：`src/bridge.ts:451-458,621-650`、`src/bridge-scoped.ts:69-127`、`README.md:50,70`。
- canonical usage journal / accounting：`README.md:58`、`src/usage-journal.ts:155-183`、`src/accounting-service.ts:43-79`。
- idle timeout / kill tree：`src/spawn.ts:264-295,404-459,469-480`。
- 无官方 seam：`src/index.ts:54` 的 `inject = []`；自写 `systemSpawn`：`src/spawn.ts:47-53`。

---

## 4. 兼容性矩阵：为什么不建议直接切换

| 维度 | 官方 seam 要求 | 本项目现状 | 结论 |
|---|---|---|---|
| 工具契约 | `dsh-tool-subagent` 返回 `{kind:'activation', name}`，完成后异步通知 | `dispatch_cli_task` 同步返回 `DispatchValue`，包含 `finalText/sessionRef/notes/...` | 冲突 |
| 结果语义 | `SubagentResult{output, stopReason, diagnostic}` | `DispatchValue{ok, phase, error, finalText, sessionRef, ...}` + `MaestroStage` + `MaestroResultState` | 语义不等价 |
| 进程所有权 | `ctx.subprocess.spawn` managed range；包内 wrapper / SDK custom spawn | 自有 `node:child_process.spawn`、PATH 检测、Windows `.cmd` 处理、idle 行流、taskkill | 冲突 |
| cwd | seam 解析相对 cwd，provider 再校验绝对/可进入 | 工具只收绝对 cwd，缺省用 Session header / `process.cwd()` | 部分冲突 |
| env | scrubbed 父环境 + 显式 env；原生设置权威 | 继承 `process.env` + 显式 DSH 模型/MCP 凭据；显式覆盖用户 CLI 设置 | 部分冲突 |
| resume | one-shot，不支持 | `resume` 一等能力 | 冲突 |
| 模型 | 静态 `model` 或原生设置 | DSH 目录、协议闸门、预检、thinking | 冲突 |
| 桥接 | 无宿主工具/MCP 桥，elicitation deny | `dsh_bridge`、skills、scoped files、profile MCP | 冲突 |
| UI/账本/进度 | 无 | 任务面板、事件流、用量、健康、历史 | 冲突 |
| 超时 | 无 wall-clock / elapsed timeout；仅取消与 teardown bound | idle watchdog、重连期限、deadline、重试 | 冲突 |
| 取消 | `subprocessRunHandle.dispose()` + managed range quiescence | `AbortController` + `runProcess` kill tree + 有界清理 | 可借鉴，但直接替换冲突 |

核心判断：**切换官方后端不是替换 `spawnFn`，而是重写工具契约、任务生命周期、结果回填、模型注入、UI 与账本。**

---

## 5. 可借鉴清单（按优先级）

### P0-1：统一终态结果契约（最值得吸收）

**官方做法**

- Codex：必须等 `turn/completed`；以 `final_answer > partial_answer > phase:null` 选答案；`commentary` 忽略；未知 phase 失败；完成但无答案失败：`CX/src/wire.ts:345-374,389-400,665-682,685-710`。
- Claude：必须 `type:'result' && subtype:'success' && !is_error && result.trim() !== ''`，且 iterator 正常结束：`CL/src/run.ts:206-261`。
- 发布后 `result` 永不 reject，取消赢竞态，错误 flatten 为 `error`：`SEAM/src/out-of-process.ts:141-178`。
- 统一 `stopReason` + 4096-byte diagnostic：`SEAM/src/types.ts:260-286`、`SEAM/src/out-of-process.ts:18-48`。

**本项目差距**

- Claude `ok` 主要看 exit code、非空 `finalText`、无 `resultError`，没有强制 `subtype === 'success'` 与 iterator 正常结束：`src/channels/claude.ts:365-370,401-423`。
- Codex `ok` 不要求 `turnStatus === 'completed'`，只要求不是 `failed`、无 pending stream error、答案非空、exit 0：`src/channels/codex.ts:501-508,541-549`。
- `DispatchValue` 没有 `stopReason`：`src/tool.ts:26-44`、`src/dispatch.ts:209-223`。
- `MAESTRO_RESULT` 是看板状态协议，不等价于宿主终态 stopReason：`src/result-protocol.ts:19-53`。

**建议落点**

1. 新增 `src/result-contract.ts`，定义内部 `CliTerminalResult`：

   ```ts
   type MaestroStopReason =
     | 'completed'
     | 'aborted'
     | 'error'
     | 'max-tokens'
     | 'timeout'
     | 'interrupted'

   interface CliTerminalResult {
     finalText: string
     terminalSeen: boolean
     strictSuccess: boolean
     stopReason: MaestroStopReason
     diagnostic?: string
   }
   ```

2. 在 `src/channels/claude.ts`、`src/channels/codex.ts`、`src/channels/grok.ts` 产出统一 terminal result。
3. 在 `src/dispatch.ts:1024-1093` 统一消费；`DispatchValue` 可增加可选 `stopReason`，不改现有必填字段，先保持输出 schema 兼容。
4. 剥离成功 `finalText` 末尾的 `MAESTRO_RESULT` 协议行（只进看板，不回主模型）；解析失败按 unknown，不从自由文本猜。

**验收**

- Claude 返回 `result` 但 `subtype != success` / `is_error=true` 时判失败。
- Codex 无 `turn.completed` 但有 `agent_message` 时判失败或至少 `terminalSeen=false`。
- Grok 成功 result 与 error frame 同时出现时判失败。
- 空答案、仅有 commentary、iterator 异常均不能算 `ok:true`。
- `resume`、`sessionRef`、看板 stage、用量 stats 不受影响。

### P0-2：安全诊断分层与模型侧信息边界

**官方做法**

- 固定 stage/category/outcome/httpStatus，不把原始 stderr、raw payload、命令、路径给父模型：`CX/src/run.ts:71-129`、`CL/src/run.ts:62-136`。
- stderr 只进 Host stderr / `inherit`，不进父 Session：`CX/src/run.ts:256-281`、`CL/src/process.ts:46-60`。
- diagnostic 限 4096 UTF-8 bytes，不切断 UTF-8 序列：`SEAM/src/out-of-process.ts:18-48`。

**本项目差距**

- `systemSpawn` 继承完整 `process.env` 并叠加显式 env：`src/spawn.ts:47-53`。
- Claude/Codex/Grok 把 stderr 行转成 `note` 事件，失败时 `stderrTail` 进入 `error`，再经 `renderSummary` 回主会话：`src/channels/claude.ts:396-423`、`src/channels/codex.ts:530-565`、`src/tool.ts:239-251`。
- 已有端点/传输脱敏：`src/public-diagnostics.ts:4-42`，但不是全链路诊断契约。

**建议落点**

1. 新增 `src/public-diagnostics.ts` 的扩展函数（或新 `src/diagnostics.ts`）：`safeDispatchDiagnostic(error, phase, cli, stage)`。
2. 输出固定字段：`product / cli / stage / category / exitCode / signal / timedOut / aborted / httpStatus?`；不输出 stderr 原文、命令、路径、raw JSON。
3. 模型侧 `DispatchValue.error` 只放安全摘要；完整 stderr 留在 `/task/detail`、`registry` 事件与日志。
4. 对 `error`、`detail`、`notes` 做 4096 UTF-8 byte 裁剪；保留 `publicEndpointUrl` / `transportDiagnostic` 现有策略。
5. 默认不改事件流；先把「回主会话的错误」与「看板诊断」拆开。

**验收**

- 失败任务的模型可见文本不含 `ANTHROPIC_AUTH_TOKEN`、`MAESTRO_DSH_PROVIDER_KEY`、URL query、stderr 原文。
- 任务详情仍能看到必要诊断。
- 取消、超时、中断、失败的 phase 与现有 UI 不回归。

### P0-3：环境 scrub、显式 opt-in 与 cwd 可进入校验

**官方做法**

- `scrubbedParentEnv()` 清除凭证形名称与 `DSH_*`，显式 `env` 后叠加：`SUBPROC/src/index.ts:47-87`。
- Claude SDK spawn overlay 用 `undefined` tombstone 保证 SDK 删除项不复活：`CL/src/process.ts:25-38`。
- cwd 必须绝对、存在且可进入：`SEAM/src/out-of-process.ts:94-112`。

**本项目差距**

- 主 CLI 进程继承 `process.env`；只对 MCP stdio 子进程做凭据清理：`src/spawn.ts:47-53`、`src/mcp-env-shim.ts:10-27`。
- `usableWorkspaceCwd` 检查存在目录，但没有 POSIX `X_OK` / 可进入语义的统一校验：`src/dispatch.ts:447-465`。
- 本项目的 DSH 模型注入、Claude `--settings`、Codex `--ignore-user-config`、MCP 密钥别名依赖显式环境，env scrub 必须保守。

**建议落点**

1. `src/config.ts` 增加默认关闭的 `scrubInheritedEnv`（或 `envPolicy: 'legacy' | 'scrubbed'`），避免一升级就破坏用户已有 CLI 登录态。
2. `src/spawn.ts:47-53` 构造环境时改为 `scrubbedBaseEnv + explicit overlay`；显式 overlay 必须最后写入，保证 `MAESTRO_DSH_PROVIDER_KEY`、`ANTHROPIC_AUTH_TOKEN`、`MAESTRO_MCP_SECRET_*`、bridge URL/token 不被误删。
3. 保留 `PATH`、`HOME`、`SystemRoot`、平台必需变量；不要照搬官方「所有 `DSH_*` 都清掉」的强策略，除非先确认桥接所需的 `DSH_*` 已显式注入。
4. `src/dispatch.ts:447-465` 增加可进入校验：绝对路径、目录、可 `X_OK`；失败时明确 note，不静默落到错误目录。

**验收**

- 显式模型/MCP 凭据仍工作。
- 默认 legacy 行为零变化；开关打开后，父环境里的 `*_TOKEN` / `*_KEY` / `*_SECRET` / `PASSWORD` 不自动进入主 CLI。
- Windows、POSIX 的 cwd 权限错误在 spawn 前可见。

### P1-1：只读 seam 能力探针，不切换后端

**建议落点**

- `src/host-capabilities.ts` 增加 `dsh-subagent`、`dsh-subprocess`、`dsh-tool-subagent` 版本/成员探测。
- `src/index.ts` 用可选 `ctx.inject(['subagents','subprocess'])` 捕获 face，只传给 `/overview`。
- 不 `registerProvider`、不注册 `subagent_codex` / `subagent_claude_code`、不改 dispatch。

**收益**

- 未来若官方 seam 变更，`GET /overview` 能先暴露兼容信息。
- 可以与本项目的 `hostCapabilities` 报告合并，不需要改变运行时行为。

### P1-2：发布边界、幂等 dispose 与清理失败分离

**官方做法**

- Codex 就绪后才发布；Claude SDK custom spawn 捕获后才发布：`CX/src/run.ts:315-354,380-438`、`CL/src/run.ts:441-516`。
- `subprocessRunHandle.dispose()` 幂等：`SEAM/src/out-of-process.ts:196-216`。
- Codex / Claude teardown 都等待 managed-range quiescence：`CX/src/run.ts:190-217`、`CL/src/run.ts:270-306`。

**本项目现状**

- 已有 `watchChildClose`、`killTree`、5s/6s 有界清理：`src/spawn.ts:404-459,469-480`，方向正确。
- 但「启动前失败、发布后失败、cleanup 失败、result 失败」在 `runDispatch` 里仍混在一次 Promise catch 中：`src/dispatch.ts:1107-1145`。

**建议落点**

- 不重写进程系统；在 `src/dispatch.ts` 的失败构造函数中给 post-spawn 异常打固定 stage/category，并把 cleanup failure 与 task failure 分开记录。
- 在 `src/child-session.ts:75-81` 的 `cliChildTurnEndReason` 中纳入未来 `stopReason`，但保留 `MaestroPhase` 兼容。

### P2-1：可选 Codex app-server 实验通道（仅评估，不建议近期默认）

官方 Codex app-server 协议提供了更严格的 `thread/start` / `turn/completed` / final answer 语义。若未来需要「官方协议级 Codex 通道」，可以在 `src/channels/codex-app-server.ts` 做实验实现，并由配置项 `codexTransport: 'exec-json' | 'app-server'` 默认保持 `exec-json`。

但注意：

- rc.3 已锁定 `@openai/codex@0.153.4` 包内 wrapper；本项目当前使用宿主 CLI + `exec --json` + resume + rollout usage：`src/channels/codex.ts:92-145,435-565`。
- 切换 app-server 会牺牲现有 `exec resume` 与 rollout usage tail，除非重新实现续接与用量。
- 官方 app-server 是 ephemeral thread，和本项目 resume 目标冲突：`CX/src/wire.ts:289-302`。

因此此项只作为协议研究，不列入短期改造。

---

## 6. 不建议照搬的模式

| 官方模式 | 证据 | 不照搬原因 |
|---|---|---|
| 一次性、ephemeral、不持久化产品会话 | `CX/src/wire.ts:289-302`；`CL/src/run.ts:330`；`CX/README.zh.md:167`；`CL/README.zh.md:169` | 本项目 `resume/sessionRef` 是核心能力 |
| 静态 providerName/model/permissionMode | `CX/src/index.ts:35-59`；`CL/src/index.ts:38-66` | 本项目要逐调用路由、模型、thinking、cwd、resume |
| 全局 `subagent_codex` / `subagent_claude_code` 工具 | `CX/cordis.patch.yml:1-9`；`CL/cordis.patch.yml:1-9` | 会与 `dispatch_cli_task` 形成双工具面；破坏难度门槛与统一结果契约 |
| `NO_START_CAPABILITIES` | `SEAM/src/out-of-process.ts:50-61` | 会拒绝 agentOptions/outputSchema/depthLimit，与模型选择和结构化能力方向不一致 |
| `maxDepth: provider-managed` | `CX/cordis.patch.yml:9`；`CL/cordis.patch.yml:9` | 本项目明确在 Host 侧做难度/委派门槛治理 |
| 包内锁定平台载荷、不回退宿主 CLI | `CX/package.json:50-55`；`CL/package.json:50-57`；`CL/README.zh.md:173` | 载荷体积大、许可/安装闭包复杂；本项目 CLI 安装/版本管理是卖点 |
| 原生产品设置和认证完全权威 | `CX/README.zh.md:96-97,169`；`CL/README.zh.md:98,171-172` | 本项目显式 DSH 模型/凭据注入是为了可复现，不被用户 `~/.claude` / `~/.codex` 静默覆盖 |
| 无 wall-clock timeout、无副作用回滚 | `CX/README.zh.md:175`；`CL/README.zh.md:177` | 本项目已有 idle watchdog、deadline、effects、interrupted 恢复 |
| blanket MCP elicitation / user input deny | `CX/src/wire.ts:617-625`；`CL/src/run.ts:351-369` | 会切断 `dsh_bridge` 的宿主工具/技能桥；本项目需要按 scope 精细授权 |
| 无进度流、无用量、无 UI | `CX/README.zh.md:167,173`；`CL/README.zh.md:169,175` | 本项目看板、账本、会话页是核心产品能力 |

---

## 7. 落地路线与验收

### 阶段 1：不换后端，先统一结果和诊断（推荐先做）

| 项 | 文件 | 验收 |
|---|---|---|
| 新增 `CliTerminalResult` / `MaestroStopReason` | `src/result-contract.ts`、`src/wire.ts`、`src/tool.ts` | 三通道返回统一 terminal 字段；输出 schema 保持兼容 |
| Claude strict success | `src/channels/claude.ts` | `subtype != success`、`is_error`、空 result、iterator 异常均失败 |
| Codex terminal event | `src/channels/codex.ts` | 无 `turn.completed` 不算严格成功；final/partial/unphased 优先级明确 |
| Grok error frame | `src/channels/grok.ts` | 成功 result + pending error 不能算成功 |
| 安全诊断 | `src/public-diagnostics.ts` 或 `src/diagnostics.ts`、`src/dispatch.ts` | 模型侧错误不含原始 stderr/凭据；4096-byte 裁剪；phase 不回归 |
| 剥离 `MAESTRO_RESULT` | `src/result-protocol.ts`、`src/dispatch.ts` | 看板仍解析 stage；主模型 finalText 不再含协议行 |

### 阶段 2：环境与 cwd 安全增强

| 项 | 文件 | 验收 |
|---|---|---|
| 默认关闭的 `scrubInheritedEnv` | `src/config.ts`、`src/spawn.ts` | legacy 行为零变化；开启后 ambient secrets 不进主 CLI；显式密钥仍有效 |
| cwd 可进入校验 | `src/dispatch.ts` | 绝对路径、目录存在、可进入；失败明确 note |
| 只读 seam capability probe | `src/host-capabilities.ts`、`src/index.ts`、`src/routes.ts` | `/overview` 能看到 seam 版本/成员；dispatch 行为不变 |

### 阶段 3：选择性研究，不默认启用

| 项 | 文件 | 门槛 |
|---|---|---|
| 可选 Codex app-server 实验通道 | `src/channels/codex-app-server.ts`、`src/config.ts`、`src/dispatch.ts` | 必须证明不影响现有 resume、rollout usage、Windows launch；默认仍 `exec-json` |
| 可选 `ctx.subprocess` adapter | `src/subprocess-seam.ts`、`src/spawn.ts` | 只在宿主 seam 可用时启用；缺失回退现有 `systemSpawn`；不得破坏 idle 行流/用量/取消 |

---

## 8. 核验中发现的文档/实现细节偏差

这些偏差不影响主结论，但整合官方经验时应以源码为准：

1. 官方 README 的「缺失载荷在 `initialize` / `query-start` 阶段失败」是用户语义概括；Codex `CODEX_PACKAGE_BIN` 在模块加载期就解析，可能先于 `start()` 失败：`CX/src/run.ts:44-53`；Claude `officialQuery()` 失败后才构造 `query-start/unknown`：`CL/src/run.ts:440-516`。
2. Claude README 源码地图把 `process.ts` 描述成 dispose 相关；实际 `process.ts` 是 SDK spawn spec + `SpawnedProcess` 投影，dispose ladder 在 `run.ts`：`CL/src/process.ts:25-61`、`CL/src/run.ts:270-306`。
3. 官方说诊断「只包含固定阶段、类别和进程事实」；源码还生成无人值守决策诊断，仍是固定 provider-authored 文本：`CX/src/wire.ts:150-157,527-540,574-626`；`CL/src/run.ts:138-145,316-377`。
4. 官方「原始错误只保留在 Host 日志/cause 链」应理解为「不进模型/父 Session」，不是全局日志也看不到；Host logger 会记录完整 error 对象：`CL/src/index.ts:93-98,107-112`。
5. 本仓库 `package.json:3` 是 `0.1.17`，而 `README.md:80-87` 已有 `1.0.0` 版本日志段落；这是本项目自身的版本叙述不一致，建议单独整理。

---

## 9. 最终建议

**保留 `dsh-maestro-codex` 现有主执行链路**，即：

```text
dispatch_cli_task
  → runDispatch
  → channels/claude.ts | channels/codex.ts | channels/grok.ts
  → spawn.ts
  → TaskRegistry / UsageJournal / child-session / client board
```

把官方 0.2.2-rc.3 当作以下三类输入：

1. **规范输入**：终态结果、stopReason、安全诊断、发布边界、cleanup quiescence。
2. **安全输入**：env scrub、explicit opt-in、cwd 可进入校验、stderr 不回模型。
3. **只读兼容输入**：`/overview` 的 seam capability report。

不要做：

- 不启用 `subagent_codex` / `subagent_claude_code` 全局工具作为主入口；
- 不把 `dispatch_cli_task` 改成 `dsh-tool-subagent` 的异步 activation 模式；
- 不把包内锁定产品载荷替换当前 CLI 安装/版本/路径管理；
- 不引入官方 one-shot/ephemeral 语义来替换 `resume`；
- 不照搬 blanket deny 的 MCP/user input 策略来切断 `dsh_bridge`。

**优先级建议**：先做 P0-1（终态契约）+ P0-2（安全诊断），再做 P0-3（环境与 cwd），最后把 P1-1（seam 能力探针）作为兼容性观测。这样可以用较小改动吸收官方最成熟的部分，同时不损失本项目已经明显领先的产品能力。
