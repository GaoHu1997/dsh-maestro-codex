# dsh-maestro-codex

[![npm](https://img.shields.io/npm/v/dsh-maestro-codex?logo=npm)](https://www.npmjs.com/package/dsh-maestro-codex)
[![release](https://github.com/GaoHu1997/dsh-maestro-codex/actions/workflows/release.yml/badge.svg)](https://github.com/GaoHu1997/dsh-maestro-codex/actions/workflows/release.yml)
[![license](https://img.shields.io/npm/l/dsh-maestro-codex)](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/LICENSE)

dsh 的 CLI 子代理编排插件：把会话中的任务按类型派发给 **codex cli** 或 **claude cli**（headless）执行，取回结果回填主会话。

## 能力

- **dispatch 工具**：在主会话注册 `dispatch_cli_task` 工具，派发前由主代理先判断该任务是否需要开子代理——不需要就自己完成；需要时再评估任务难度并给出理由，达到配置门槛才派发，未达门槛改用 dsh 子代理（`subagent` / `subagent_fork`），不启动 CLI。
- **独立难度门槛**：在「CLI 管理」展开 Claude / Codex，各自选择低 / 中 / 高 / 极高（默认中），即时生效，互不影响；未单独设置时兼容沿用旧的统一门槛。调用工具传 `task_difficulty`（`low / medium / high / extreme`）与 `difficulty_reason`，按实际选定 CLI 的门槛校验，不改选门槛更低的 CLI 绕过限制。旧调用未评估按低处理，显式指定 `cli` 也不能绕过门槛。低：问答、查询、局部编辑；中：常规多步骤任务；高：跨模块重构、复杂调试；极高：系统级设计或迁移。难度由主代理评估，类型关键词只负责选择 CLI，不抬高任务难度。
- **路由表**：配置页以卡片点选为每个 CLI 配置任务类型与默认 CLI；内置任务统一为 13 个四字名称，悬停查看具体工作与交付要求。Claude 默认选择仓库探索、影响分析、模块重构、方案设计、文档整理；Codex 默认选择功能开发、缺陷修复、测试验证、代码审查、数据处理。代码定位、资料检索、方案核验同样可手动分配给任一 CLI，本版不新增 DSH 管理配置。旧内置名称自动映射为新名称并保留旧关键词路由兼容，不覆盖用户已有分工或自定义类型。
- **技能 / 工具桥（dsh_bridge）**：派发时把 dsh 的技能与宿主工具一起交给 CLI 子代理，来源都是 dsh 本体，没有第二套配置。**技能**：dsh 技能目录（名称 + 摘要）注入任务开头，全文经随包分发的 `dsh_bridge` stdio MCP 服务器（`skill_<name>` 工具）按需加载——与 dsh 主会话自己的两段式技能体验对齐；只暴露「模型可调用」的技能，`disable-model-invocation` 与 `*.disabled` 在主会话不可见的这里同样不可见。claude 另可选**原生模式**（`claudeSkillsMode: native`）：把技能暂存成临时 `.claude/skills` 树以 `--add-dir` 挂上，由 claude 自带的 Skill 工具与 `/技能名` 加载，frontmatter 的 `whenToUse` 会改写为 claude 认的 `when_to_use`；暂存失败自动回退桥模式。**宿主工具**：`ctx.tools` 注册表按模式桥接（`bridgeTools: off / auto / custom`），auto 用内置排除表滤掉 shell/文件/会话/编排类（bash、read、edit、todo、subagent 等——子代理有自己的，桥过去还会绕过 dsh 的沙箱审批），custom 按精确名单；http 传输的 MCP 工具只能经 custom 名单到达子代理。桥接调用仅在具备可信代理和真实工具 scope 时走 dsh 的完整工具流水线（pre-execute → guard → dispatch → post）；缺少该宿主 seam 时明确拒绝宿主工具调用，技能桥仍独立可用。每次派发签发一次性 token，任务结算即作废并中止进行中的桥接调用。权限、会话能力与宿主限制详见 [CLI 安全说明](docs/cli-safety.md)。放在 `.agents/skills`（项目或 `~/.agents/skills`）的技能，codex 子代理不经桥也能原生读到——两个体系对这套目录天然共享。
- **权限配置**：claude 支持 `default / acceptEdits / plan / bypassPermissions`（`继承` = 使用 CLI 非交互默认策略）；codex 通过沙箱（`read-only / workspace-write / danger-full-access`）划界。API 地址、Token、CLI 路径、超时等收在「高级连接设置」里，默认折叠。
- **模型配置（dsh 目录直选）**：配置页的「dsh 模型」下拉直接列出 dsh 中已配置的供应商与模型（读取 llm-pi-ai 设置 + credentials 密钥）。选中后插件自动把端点/密钥/模型注入 CLI——codex 经 `-c` 合成 model_provider（OpenAI 兼容供应商，`openai-responses` 与 `openai-completions` 都可选，统一按 responses 方言驱动；codex 0.146+ 已移除 chat 支持），claude 经 ANTHROPIC_BASE_URL/AUTH_TOKEN（仅 anthropic-messages 协议），并把同一组变量写进一次性的 `--settings` 文件——Claude Code 会用它自己 settings 文件里的 `env` 块覆盖进程环境变量；只设进程 env 时，用户 `~/.claude/settings.json` 里残留的网关会静默顶替配置页的选择（旧网关失效时整轮任务直接 403）。**默认沿用主代理当前选择的模型**（协议不支持该 CLI 时改用配置页的选择）；工具参数显式指定 `provider::model` 时锁定该 DSH 供应商；裸模型名也只能在主代理或配置页的可信 DSH 供应商上解析和预检，不能绕过端点校验。两者都拿不到可用端点时任务**直接失败并列出原因**（例如主代理是 anthropic-messages 协议却派给 codex + 配置页没选模型），不会回落到 CLI 自身配置文件里的模型——那是另一套供应商与密钥。codex 在注入 dsh 端点时以 `--ignore-user-config` 运行，用户自己的 `~/.codex/config.toml`（自带 model/model_provider、`model_instructions_file`、notify、插件与 MCP 服务器）不再参与派发的任务；被一起甩掉的 `[windows] sandbox` 由插件补回（Windows 上重新声明 `windows.sandbox="elevated"`，否则 codex 会拒绝执行任何命令，子代理连文件都读不到）。真正 spawn 之前还有一道**模型预检**：协议不匹配的候选直接跳过；端点不接受该模型名时（供应商没声明这个模型，或探针返回 404）当场报出是哪家供应商、哪个模型，不再让 CLI 跑到一半才失败；预检只是 1-token 的最小请求，连不通时记为「无法判定」仍然照常派发。
- **思考等级**：档位**来自所选 dsh 模型自身配置的 `reasoningEfforts`**（llm-pi-ai 模型条目），不写死——选了模型，思考等级下拉就列该模型声明的档位（如 off / low / medium / high）；未选模型或模型未声明时只能保持默认。claude 经 `MAX_THINKING_TOKENS` 传参（off/none→0，low/medium/high→4k/10k/32k，未映射的档位忽略）；codex 经 `-c model_reasoning_effort` 原样传参（codex 不认的档位如 off 自动跳过），与「-c 覆盖项」同时设置时覆盖项优先。
- **CLI 管理**：配置页检测版本、按版本安装/卸载（npm -g：`@anthropic-ai/claude-code`、`@openai/codex`），版本列表只列正式版并标注当前平台，支持自定义 registry。
- **任务监视**：只记录 `dispatch_cli_task` 派发的子代理任务（带 CLI 徽标，与主会话自己执行的工作区分开）；进度事件流、取消、超时（每 CLI 可配）、并发上限。
- **任务看板**：装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 时，右侧栏多一个「任务看板」tab。直接移植该项目 **0.28.2 原版任务管理**：真实分层图、SVG 曲线、点阵背景、缩放/拖动/适配、图/树切换、两段式卡片、自动折叠、原版详情浮层与后台任务抽屉，源码与 CSS 有逐字节/等价测试。仅在数据桥接层加入 CLI 子代理：按所属会话挂接、外部目录去重、阶段/耗时/Token/转录/取消，继续使用既有路由；不再使用旧的纵向缩进图与额外筛选栏。页头 CLI chip 与 `maestroCliUsage` 继续提供统一入口和统计；会话接口现由可信宿主 capability 授权，sessions 只能收窄，后台作业输出游标语义保留。详见 [任务板说明](docs/task-board.md)。
- **CLI 会话页**：CLI 子代理可建立 one-shot DSH 记录镜像（不是普通 DSH 执行器对话）。任务详情和顶部入口优先打开右侧 CLI 对话页，宿主缺少右栏 seam 时才回落覆盖层；观感对齐 DSH 的会话窗口：任务全文是右侧的用户气泡，CLI 的流式回答是左侧气泡，工具调用与阶段折成细窄的系统行，多轮回复按 `replyTo` 串成一整段对话。底部输入框可以直接**续发消息**——走 `POST /task/reply` 起一个带 `resume`（claude `--resume` / codex `exec resume`）的新回复任务，原任务的难度门槛与 CLI 路由原样沿用；链尾失败/超时没拿到会话引用时自动退回最近一个可续接的轮次，同一会话同时只允许一条回复在跑（发送后到列表刷新前输入框锁定，服务端再兜一层 409）；续发默认继承上一轮 DSH 模型与思考配置；服务端支持显式 DSH 模型选择（按 CLI 协议过滤），绝不读 CLI 自身配置。页面必须持有当前父会话的宿主能力；地址 scope 不授权，原 CLI 禁用时拒绝而不换执行器。
- **用量与请求记录**：调用开始先在 `$DSH_HOME/maestro/usage-journal` 写 canonical pending 标记，结束后保存不可变结算记录；成功、失败、取消和超时均保留实际已采集消耗。`maestroCliUsage` 是从该权威账本恢复的父会话显示投影，**不再追加私有 `maestro/cli-usage` 事件到严格会话日志**。累计及幂等身份独立于 recent 窗口；未知桶保持 null，`knownTotals` 仅为已知小计。公开 `maestroCliAccounting.read/settlements` 服务要求父会话的宿主能力，单独 sessionId 不授权。可选标准子记录镜像使用相同 usageId 与父子归属；消费者不可将父自定义投影与标准子记录相加，也不能把 CLI 消耗算作父主模型的调用。Codex 的 inclusive input 同时扣除缓存读和缓存写；resume 在进程启动前捕获线程累计基线，只计当轮增量。stdout 与 rollout 在原始计数层合并，避免二次计算缓存写；基线缺失或回退时明确降级，不把历史或缺失值当成本轮零消耗。用量展示成功不代表宿主标准重放或每个统计插件已验证，必须按真实版本逐层对账。历史错误账务不随代码升级自动改写；严格日志兼容与离线恢复见 [历史恢复说明](<docs/session-history-recovery-guide.md>)。
- **任务结果落盘**：每次派发结算后，把任务摘要、最终文本与事件尾（最近 200 条）写入 `$DSH_HOME/maestro/tasks/<taskId>.json`（最多保留 200 条，可在「调度设置」关闭）。插件启动时把最近 40 条读回来种进任务表——重启后「任务监视」仍能翻看历史结果与转录。
- **可靠性面**：派发前把 `launch` 行落进 `$DSH_HOME/maestro/effects.json`（同键覆盖、5s→300s 退避、三连败进健康面板），任务到终态即结算；进程被杀留下的行在下次启动时变成 **`interrupted` 任务**（终态但不算失败，阶段显示「已中断」，等你决定是否重派）。同一父会话 + CLI + 任务名 + cwd 在 10 分钟内重复派发会被幂等键挡下（`dedupe_key` 可显式指定，续接不参与）。派发末尾提示 CLI 用一行 `MAESTRO_RESULT {"state","human_action","summary"}` 交代收尾，读不到就当没说、绝不从自由文本里猜。新增 `GET /health`（七个单写者健康条目）、`GET /status`（阶段计数 + 待处理副作用）、`GET /prompts` + `POST /prompts/save`（可改写提示模板，默认变动后标 `stale`）、`GET /config-history`（脱敏后的配置变更历史）。阶段派生 `stage = person/answer · person/review · person/blocked · person/failed · working/queued · working · idle`，看板据此显示「等你回话 / 等你验收」。命令行看快照：`node scripts/maestro-status.mjs [--json]`。详见 [可靠性面](docs/reliability.md)。
- **会话续接（resume）**：工具支持 `resume` 参数，传上次结果里的 sessionRef（Claude session id / Codex thread id），通过真实 CLI resume 保留记忆，不自动继承父会话上下文。成功或失败的已创建任务均返回 taskId、phase；取得 sessionRef 后即使失败也保留它，失败结果仍明确 `ok:false`，不把错误变成成功。引用必须归属当前可信父会话，续接生成 replyTo 链并固定原 CLI/cwd，同一真实会话链只允许一个并发续接。前置参数、难度、权限或归属拒绝仍直接报错，不创建可续接的假任务。
- **宿主能力与版本检测**：插件只通过公开服务适配宿主，不同 dsh 版本暴露的成员并不一致。每次读概况（`GET /overview`）都会带一份 `hostCapabilities` 报告：逐个列出 `settings / skills / agents / sessions / sessionQuery / sessionPersistence / sessionProjections / tools / systemPrompt / webServer` 是否解析成功、缺哪些成员（`degraded: none | partial | absent`）、缺失时的实际影响，另附 `@deepseek-ai/dsh-session`、`dsh-scope`、`dsh-host-webserver`、`dsh-settings`、`cordis` 的真实版本号（读不到为 `null`，不编造）。报告同时给出 `permissionContext`：宿主工具的可信上下文来自 `agents.get` 返回的真实 Agent、转发的是宿主自己的 symbol parent token，且**地址里的 scope 参数从不参与授权**。这份报告只做观测：不调用宿主、不改宿主、不读取私有状态，也不因为某项缺失而放宽任何权限——缺失的 `sessions`/`sessionProjections` 只会让原生镜像与公开投影按前述规则 fail closed。
- **拓扑可见，不进后台任务**：启用原生记录且宿主支持时，派发为 CLI 创建真实 `cli-<taskId>` 子记录，并追加符合宿主 schema 的 `mode: 'one-shot'` 目录行；不再写 `mode: external`。顶部统一入口与看板将镜像和 CLI 任务去重。记录只提供查看和标准统计，不能交给普通 DSH 执行器回复；续接只走 Maestro 的原 CLI 工具或页面入口。CLI 任务不登记到宿主后台 jobs，避免同一任务出现两份状态与取消入口。
- **派发上下文与韧性**：派发前可自动把 cwd 的 git 工作区快照（分支/未提交改动，只读）拼进任务开头（`injectGitContext`，默认开）；CLI 超时指连续无 stdout/stderr 非空输出分片的时长（`timeout_minutes`，1–240 分钟，不是总运行时长），每个真实输出分片重置计时；这是无输出保护，不判断任务语义进展。无输出窗口剩余约 1/5（至多 2 分钟）时在事件流预警，恢复输出也重置预警；版本检测、npm 等一般进程仍按总时长超时；普通失败可配置自动重试（`failureRetries`，0–2，默认 0——会改文件的任务建议保持 0，超时与手动取消永不重试）。前置准备可用 `prepareCommand`（默认空，≤4000 字符）：在任务 cwd 里先跑一次（例如 `git worktree add`），失败则本轮 `failed` 且不启动 CLI。

## 执行方式

- claude：`claude -p --output-format stream-json --verbose`，任务文本走 stdin；`resume` 时追加 `--resume <sessionId>`。
- codex：`codex exec --json --skip-git-repo-check --ignore-user-config -`，任务文本走 stdin；`resume` 时为 `codex exec resume <threadId> --json …`，续接指令同样走 stdin。

## 安装包内容与入口

安装包只交付编译后的 [lib](<lib>)、补丁/许可/图标/语言资源、本页链接的用户说明与 [状态脚本](<scripts/maestro-status.mjs>)；不包含源码、开发构建脚本或历史测试/修复证据。运行状态脚本请先进入实际插件安装目录，或把命令中的路径改成该脚本的绝对路径。它只依赖与插件相同的 Node（`>=22.19`，内置 `fetch`），无需补装其他脚本。

主入口仍为 [lib/index.js](<lib/index.js>)，声明为 [lib/index.d.ts](<lib/index.d.ts>)。`dsh-maestro-codex/client` 的声明由真实 [客户端入口](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/src/client/index.ts) 生成到 [lib/client.d.cts](<lib/client.d.cts>)；对应 [lib/client.js](<lib/client.js>) 是交给 DSH Web `__ModuleLoader__` 的 CJS factory，不是独立 Node 命令或可在 Node 直接执行的浏览器模块。下列开发命令只在源码仓库使用；安装包的运行桥是 [lib/bridge-shim.js](<lib/bridge-shim.js>)，不需要开发期 `build-upstream` 脚本。

## 版本日志

### 0.1.5

- **技能 / 工具桥（dsh_bridge）**：随包分发的 stdio MCP 服务器把 dsh 的技能目录与宿主工具按模式桥接给 CLI 子代理，与主会话两段式技能体验对齐；claude 另可选原生 `.claude/skills` 暂存模式，暂存失败自动回退桥模式。权限与会话能力详见 [CLI 安全说明](<docs/cli-safety.md>)。
- **可靠性面**：新增持久化副作用队列（`effects.json`）、重启恢复 `interrupted` 终态、10 分钟窗口幂等键去重、`MAESTRO_RESULT` 收尾协议、`GET /health` `/status` `/prompts` `/config-history` 四个运维接口、面向人的阶段派生（等你回话 / 等你验收）与 `scripts/maestro-status.mjs` 快照脚本。详见 [可靠性面](<docs/reliability.md>)。
- **用量账本重做**：调用开始先写 canonical pending 标记、结束后保存不可变结算记录，`maestroCliUsage` 改由权威账本恢复，不再向严格会话日志追加私有事件；Codex 缓存读写计数、resume 增量基线、stdout 与 rollout 合并去重。
- **原生会话镜像**：CLI 子代理可建立 one-shot DSH 记录镜像（`mode: 'one-shot'` 目录行 + 真实子记录），顶部统一入口与看板自动去重；CLI 任务不登记宿主后台 jobs。
- **模型与续接强化**：支持 `provider::model` 锁定 DSH 供应商、裸模型名仅可信 DSH 供应商解析并预检；续接链固定原 CLI/cwd、同链单并发、失败仍保留 sessionRef 且明确 `ok:false`；新增 `prepareCommand` 前置准备。
- **宿主能力报告**：`GET /overview` 附带 `hostCapabilities`，逐项列出宿主 seam 的 `degraded` 程度与真实依赖版本号，只观测不放宽权限。
- **工程与交付**：构建改为 clean-build（先清 lib 再 tsc + tsdown），客户端声明改由真实入口生成到 `lib/client.d.cts`；安装包精简为白名单交付并附 [历史恢复说明](<docs/session-history-recovery-guide.md>)；新增会话历史修复脚本（`scripts/scan-maestro-session-logs.mjs` 等）与配套测试；测试扩至 93 个文件 / 1500+ 用例。

## 开发

```bash
pnpm install
pnpm build      # clean lib → tsc（host）→ tsdown（client.js + client.d.cts）
pnpm test       # vitest
```

安装到 dsh：在 dsh 插件市场或插件管理器安装本包；`cordis.patch.yml` 会把 `dsh-maestro-codex` 条目插入 profile。

## 参考

设计调研了 [jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) 的 ai-bridge 多 CLI 通道抽象（claude stream-json / codex app-server）。
