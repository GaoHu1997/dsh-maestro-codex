# DSH 官方 Codex / Claude Code 插件借鉴报告

> 核验日期：2026-11-14（Asia/Shanghai）。  
> 对照对象：`@deepseek-ai/dsh-subagent-codex@0.2.2-rc.3`、`@deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.3`。  
> 我方基准：`dsh-maestro-codex`，包版本 `0.1.17`，当前 HEAD `caea5bfd61e723254d21e3b8a37ee925f9894f38`；当前 DSH CLI `0.2.2-rc.3`。  
> 方法：官方 npm 元数据、工作区已有官方源码缓存、安装版 DSH 公共服务源码、我方实现与测试的只读对照。本文是分析报告，不是已经完成的改造或安全实测结论。

## 一、结论先行

**有值得吸收的地方，但应吸收“可信执行边界”，而不是整体替换我们现在的执行后端。**

官方两个插件是“宿主子代理体系里的最小一次性产品 provider”；我们是“多 CLI 的完整任务编排器”。官方在严格终态、凭据环境、诊断信息边界和资源所有权上值得借鉴；我方在动态模型路由、resume、桥接、用量账本、看板、持久恢复、无输出与重连保护方面有明显额外能力。

建议排序：

1. **P0：CLI 主进程环境默认清理凭据，再显式注入本任务所需变量。**
2. **P0：收紧 Claude / Codex 真正成功的协议条件。**
3. **P1：安全诊断结构化，原始 stderr 不默认进入父模型结果。**
4. **P1：任务结果与进程树清理状态分别记录，清理未确认不能当作已安全退出。**
5. **P1：最终 cwd 统一验证，并明确失效工作区是否允许回退。**
6. **P2：权限能力矩阵、已验证 CLI 版本矩阵，以及可选的宿主进程适配。**

一句话：**保留 Maestro 的功能主链路，用官方插件的安全与生命周期约束补强底座。**

## 二、来源与版本：先避免比较错对象

### 2.1 它们不是两个同名独立 GitHub 仓库

官方包的 repository 都指向 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，分别位于该 monorepo 的 `packages/subagent/subagent-codex` 与 `packages/subagent/subagent-claude-code`。本次以明确版本的 npm 发布包为研究基准，而不是猜测同名仓库的默认分支。

在线核验来源：

- [Codex 官方包 0.2.2-rc.3 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh-subagent-codex/0.2.2-rc.3)
- [Claude Code 官方包 0.2.2-rc.3 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh-subagent-claude-code/0.2.2-rc.3)
- 本地缓存声明：[Codex package.json](<../.tmp/official-plugins/latest/codex/package/package.json#L1-L55>)、[Claude package.json](<../.tmp/official-plugins/latest/claude/package/package.json#L1-L57>)。

本机缓存 tarball 的 SHA1 与 npm `dist.shasum` 一致：

| 包 | SHA1 |
|---|---|
| Codex 0.2.2-rc.3 | `1239619a5f3e94cf9711f74926c8cfef5a2e0aed` |
| Claude Code 0.2.2-rc.3 | `8f858fd77775ce18ea182c00605458b5ae2d2f58` |

**特别注意：核验时两个包的 npm `latest` 都仍指向 `0.0.1-rc.1`，不是 `0.2.2-rc.3`。** 因此本文称 rc.3 为“与当前 DSH 对齐的明确版本”，不称其为 npm latest；缓存目录名称 `latest` 也不能作为版本证据。见 [Codex latest 标签解析](https://registry.npmjs.org/@deepseek-ai%2Fdsh-subagent-codex/latest)、[Claude latest 标签解析](https://registry.npmjs.org/@deepseek-ai%2Fdsh-subagent-claude-code/latest)。

### 2.2 固定的产品运行基线

- 官方 Codex 包依赖 **`@openai/codex@0.153.4`**，使用包内 wrapper，而非宿主 PATH 上随机命中的版本。
- 官方 Claude 包依赖 **`@anthropic-ai/claude-agent-sdk@0.3.263`**，由 SDK 的 custom-spawn 机制接入宿主进程管理。
- 官方对 DSH 的主要 peer dependencies 精确对齐 `0.2.2-rc.3`；直接引入这些包不是一个对旧宿主无影响的小改动。
- 我方包版本依据 [我方 package.json](<../package.json#L1-L4>)。不以拟发布说明的标题推断已经发版。

本报告没有安装或启用官方插件，没有改动 Profile、版本号或运行代码；没有运行测试，也没有使用真实产品账号执行计费任务。已读取相关现有测试以核查覆盖范围。源码可构造的问题路径与现场发生过的事故要分开看。

## 三、官方实现的核心设计

### 3.1 Codex：最小 app-server 协议驱动器

```text
全局 subagent_codex 工具
    → ctx.subagents 注册的 Codex provider
    → ctx.subprocess 管理产品进程
    → initialize / initialized
    → thread/start，要求 ephemeral=true
    → turn/start
    → 匹配本线程、本轮次的 turn/completed
    → 所选答案或安全失败事实
```

特点：

- 运行发布前先完成握手与临时线程创建。
- 仅接受自包含、非空的文本任务；不自动继承父上下文。
- 答案优先级为 `final_answer > partial_answer > phase:null`；不把 `commentary` 当答案。
- 没有非空白答案的 completed 轮次仍失败。
- 权限请求、用户输入、MCP elicitation 都有明确无人值守响应；未知 server request 默认失败关闭。

证据：[官方 Codex wire](<../.tmp/official-plugins/latest/codex/package/src/wire.ts#L268-L400>)、[身份过滤与审批处理](<../.tmp/official-plugins/latest/codex/package/src/wire.ts#L574-L710>)。

### 3.2 Claude：官方 SDK 管协议，宿主管进程

```text
全局 subagent_claude_code 工具
    → Claude provider
    → SDK query() + custom spawn
    → ctx.subprocess 管理 CLI 句柄
    → 完整迭代 SDK 消息流
    → 严格成功 result + 正常迭代结束
    → 最终答案或安全失败事实
```

特点：

- `persistSession:false`，不提供产品会话续接。
- SDK custom-spawn 已交付受管活动句柄后才发布运行。
- 必须是成功 subtype、非错误且非空的 result；读取完整流，而不是见到一段文本就完成。
- 禁用 `AskUserQuestion`；plan 模式另禁用 `ExitPlanMode`；权限提示与阻塞对话有显式 deny / decline / cancel 路径。
- SDK 完整环境投影支持删除标记，避免 SDK 删除的环境变量被底层重新继承。

证据：[官方 Claude 结果与生命周期](<../.tmp/official-plugins/latest/claude/package/src/run.ts#L206-L365>)、[SDK 环境及进程投影](<../.tmp/official-plugins/latest/claude/package/src/process.ts#L25-L60>)。

### 3.3 共同的宿主契约

共享服务规定：不支持的启动能力在启动前拒绝，不能“接受后忽略”；运行发布后 result 以终态值结算，dispose 幂等，取消不依赖子进程合作，资源释放等待受管范围退出。见安装版 [共享结果与 handle 契约](<D:/devlop/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-subagent/src/out-of-process.ts#L50-L216>)。

但这并不意味着官方是完整隔离容器：它们仍保留 HOME 等环境并读取产品原生设置/身份验证；文件和外部副作用不会自动回滚。官方文档也明确没有本产品层的经过时间超时、resume、池化或进度流。进程范围的可观察性还取决于 native/fallback 提供方，不能承诺所有逃逸后代均可证明退出，见 [subprocess 限制](<D:/devlop/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-subprocess/README.zh.md#L148-L152>)。

证据：[官方 Codex 限制](<../.tmp/official-plugins/latest/codex/package/README.zh.md#L160-L175>)、[官方 Claude 限制](<../.tmp/official-plugins/latest/claude/package/README.zh.md#L162-L177>)。

## 四、与我们现有能力的对照

| 维度 | 官方两个插件 | 我方 Maestro | 判断 |
|---|---|---|---|
| 调度形态 | 固定 provider / 全局工具；先返回名称，后通知结果 | 多 CLI 路由、独立难度门槛；工具等待结构化结算，页面可先取任务 id | 不宜直接替换工具契约 |
| 模型来源 | Profile 静态选择；保留产品原生配置权威 | DSH 模型目录、协议筛选、多端点、预检，不静默借用 CLI 自身模型 | 保留我方策略 |
| 产品会话 | one-shot，不持久化、不 resume | 原生 resume、父会话归属、链路锁定和并发保护 | 保留 |
| 宿主工具/技能桥 | 不提供我方这一套 DSH 桥接 | 按需技能、scoped/custom 工具桥、真实宿主执行链 | 保留 |
| 可观测性 | 父会话保留外部身份及终态，不复制中间活动 | 进度、任务树、原生记录镜像、用量账本、健康面板 | 保留，但收紧信息边界 |
| 执行保护 | 宿主管理进程范围与取消 | idle 超时、重连期限、close 有界等待、恢复与 dedupe | 不从零重做，补资源清理证明 |
| 环境和诊断 | 默认环境 scrub；公开固定安全事实 | CLI 主进程完整继承宿主环境；失败可带原始 stderr | 真实增量借鉴重点 |
| 成功判定 | 权威终态 + 严格答案选择 | 已拒空答案与部分失败，但仍有协议条件缺口 | 优先补强 |

我方能力证据：[整体能力说明](<../README.md#L43-L70>)、[统一派发主链路](<../src/dispatch.ts#L393-L465>)、[工具失败结构化边界](<../src/tool.ts#L151-L175>)、[进程超时与清理](<../src/spawn.ts#L224-L295>)。

## 五、建议吸收的项目与验收标准

### 5.1 P0：CLI 环境默认 scrub，凭据显式 opt-in

**官方做法：** 环境基线移除匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量，以及大小写不敏感的 `DSH_*`，之后再叠加显式环境。PATH、HOME、语言和代理等运行基础仍保留。该策略来自安装版 [subprocess 环境清理实现](<D:/devlop/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-subprocess/src/index.ts#L47-L86>)，不是 Codex 插件单独发明的机制。

**我方差距：** [systemSpawn:47–53](<../src/spawn.ts#L47-L53>) 使用 `{...process.env,...options.env}`；传入任务环境并不会排除其它宿主密钥或宿主身份变量。我方 [MCP 环境 shim](<../src/mcp-env-shim.ts#L7-L26>) 已清理一批模型凭据与桥接别名，但那是 MCP 子进程边界，且是固定名称名单，不等于 CLI 主进程的通用清理。

这证明存在隐式继承路径，**不等于已经证明某次现场泄密**。

**吸收方式：** 为 CLI 运行建立一处明确的安全环境构造器；先清理宿主环境，再注入当前模型凭据及每个任务确实需要的桥接别名。MCP 子进程继续只还原自己的显式声明。不要把完整宿主环境先传成“显式覆盖”而使 scrub 失效。

**取舍：** 首先限定到 CLI 派发边界，不盲目改变 npm 管理、版本检测、prepare 等所有进程的环境契约。依赖 Git、云工具等环境凭据的任务需要显式授权通道。变量名启发式不是万能密钥识别；HOME 中的文件凭据仍须独立考虑。

**验收：** CLI 不隐式收到测试用 `GITHUB_TOKEN`、`AWS_SECRET_ACCESS_KEY`、混合大小写 `dsh_*`；当前任务的显式模型密钥仍可用；代理、PATH 和 Windows 键名合并正确；MCP A 拿不到 MCP B 的令牌。

### 5.2 P0：成功必须有权威终态，不能只是“没发现失败”

**已有覆盖不要重复建设：** 两个通道都已拒绝空白答案，也已结合退出码、取消和超时判断。相关证据：[Codex 无答案测试](<../tests/channels.test.ts#L627-L638>)、[Claude 成功条件](<../src/channels/claude.ts#L403-L422>)。

**Claude 的真实缺口：** [结果接收:365–370](<../src/channels/claude.ts#L365-L370>) 不校验 subtype；[成功条件:407](<../src/channels/claude.ts#L403-L422>) 不要求明确的非错误成功标志。因此“错误/未知/缺失 subtype + 非空 result + is_error 为 false 或缺失 + exit 0”存在被判成功的代码路径。先出现空文本的错误 result、随后出现非空成功 result，也可能因前序错误未被记录而成功。官方通过 [successfulResult / consumeClaudeQuery](<../.tmp/official-plugins/latest/claude/package/src/run.ts#L206-L260>) 严格接受成功并消费完整流。

**Codex 的真实缺口：** [成功条件:549](<../src/channels/codex.ts#L541-L556>) 仅要求 `turnStatus !== 'failed'`，不要求已观察到 `turn.completed`。于是“收到非空 agent_message 后直接 exit 0，但没有成功终态”存在被判成功的代码路径。此外，[最后消息覆盖逻辑](<../src/channels/codex.ts#L491-L508>) 没有官方的答案 phase 优先级。

**吸收方式：** 保留现有工具错误可恢复语义，但要求整体权威终态。Claude 采用已验证版本对应的严格 result 联合类型；Codex exec 采用自身 JSONL 协议状态机。若必须保留旧 msg 方言，须单独定义有证据的旧版完成契约，不能以“不是 failed”兼容一切。若该版本的 exec 暴露 phase，再做 final/partial/commentary 选择；**不能把 app-server 字段和方法原样套给 exec**。官方支持 partial phase 的代码还注明其上游来源为 0.162+，不代表固定 0.153.4 载荷必然发出该字段。

**验收：**

- Claude 错误、未知、缺失 subtype 和畸形错误标志均不伪成功；缺终态、终态后流失败有明确分类。
- Codex 只有答案没有 completed 必须失败；失败/中断终态不能完成；commentary 不覆盖明确最终答案。
- 非致命工具失败后修复并 completed 仍成功，保持 [现有恢复测试](<../tests/channels.test.ts#L610-L624>)。
- 失败时仍保留已采集 usage、真实 sessionRef、taskId 和 `ok:false`。
- 修改测试夹具中缺少标准成功字段的简写，而非为旧 fake 保留宽松生产行为。
- Grok 使用自己的结果契约，不能因复用展示解析器就被套用 Claude SDK 的字段要求。

### 5.3 P1：安全诊断事实与原始输出分流

**官方做法：** 输出固定 `product / failure stage / category / HTTP status / observed outcome`，原始异常留在内部 cause 或 Host 诊断；安全诊断有 4096 UTF-8 字节上限。示例见 [Codex failureDiagnostic](<../.tmp/official-plugins/latest/codex/package/src/run.ts#L71-L128>)。

**我方差距：** [Codex 错误结算](<../src/channels/codex.ts#L550-L565>) 可拼接 stderr；[Claude 错误结算](<../src/channels/claude.ts#L415-L422>) 可带 stderr 尾行；[renderSummary](<../src/tool.ts#L238-L251>) 直接把错误放进父模型结果。我方 [cleanLogText](<../src/wire.ts#L321-L337>) 去的是控制字符，不是凭据。现有 [公开端点诊断](<../src/public-diagnostics.ts#L1-L43>) 做了一部分安全处理，但不能覆盖全部 CLI 输出链。

**吸收方式：** 增加统一的 `failureStage/category/httpStatus/exitCode` 等事实字段。不要复用已有的人/机器 `stage` 语义字段。父模型默认接收安全摘要；原始输出走受控、脱敏、有限保留的诊断通道，不为了好排障就默认复制到父上下文与普通持久记录。

**验收：** 注入假密钥、认证 URL、任意异常长 stderr，检查工具渲染、任务事件、HTTP 响应、持久化是否按边界处理；中文 UTF-8 截断不损坏字符；仍能区分协议失败、401/403、限流、网络、权限拒绝及清理失败。

### 5.4 P1：业务结果和资源清理分别结算

**官方做法：** 资源 handle 的 dispose 幂等；停止请求之后等待受管范围退出。结果值与清理失败是不同契约，不能用“已请求 terminate”充当“已退出”。见 [Codex 清理](<../.tmp/official-plugins/latest/codex/package/src/run.ts#L184-L217>)、[Claude 清理](<../.tmp/official-plugins/latest/claude/package/src/run.ts#L263-L306>)。

**我方已有：** [watchChildClose / killTree](<../src/spawn.ts#L404-L480>) 已有有界收尾、幂等防护与 Windows `taskkill /T /F`；[回归测试](<../tests/process-close.test.ts#L20-L87>) 也覆盖管道不 close 时不伪造成功。因此不要描述成“我们完全没有进程清理”。

**仍可补强：** 当前强制收尾只在 stderr 文案说明“终止或输出完整性未确认”；`killTree` 不提供受管后代静止的证明，POSIX fallback 也主要针对直接 child。业务任务结束、管道关闭、进程范围真正静止不完全等价。

**吸收方式：** 单独保存 `cleanupState`（confirmed / unconfirmed / failed 等）并进入健康/恢复面。清理未确认时避免直接释放相关共享目录运行权、误报已终止或无条件重试有副作用任务。保留有界响应，同时继续由明确 owner 追踪清理，不让用户工具无限挂起。

**验收：** SIGTERM 被忽略、wrapper 退出但后代存活、后代不持有 stdio、taskkill 失败、dispose 重复调用、取消与成功同刻竞态，均能得出准确且只结算一次的结果与清理状态。

### 5.5 P1：统一检查最终 cwd，不把失效工作区默默变成另一处执行

**官方做法：** cwd 必须是绝对、现存且可进入的目录，不只检查 exists。

**我方差距：** [parseDispatchParams:341](<../src/dispatch.ts#L326-L367>) 显式 cwd 只检查绝对与存在，普通文件也能通过；[usableWorkspaceCwd](<../src/dispatch.ts#L370-L381>) 检查目录但未检查可进入；[最终 cwd 选择](<../src/dispatch.ts#L447-L465>) 会在会话工作区失效时记录提示并回退宿主目录。它不是完全无提示，但对会改文件的任务仍可能执行到错误项目。

**吸收方式：** 所有入口解析出最终 cwd 后集中校验目录与可进入性。明确用户指定目录失败应拒绝；会话目录失效时是否允许回退应是显式策略，改文件的任务宜默认拒绝。存在性检查不能代替沙箱/授权边界。

**验收：** 文件路径、相对路径、消失目录、不可进入目录、失效 resume 工作区、准备命令后目录变化、工具入口与页面回复入口一致；边界检查和实际执行使用同一个最终 cwd。

### 5.6 P2：权限矩阵、版本证据与可选宿主适配

**权限：** 官方默认 Codex `never`、Claude `dontAsk`；Claude 支持原生 `auto`，Codex 有 `approve-for-me` 自动评审模式。比“没有审批人，因此只能 bypass”更丰富。可借鉴显式无人值守拒绝以及模式—能力矩阵，但新模式必须先验证本地产品版本是否支持。

我方现有 [权限参数与警告](<../src/channels/claude.ts#L59-L88>) 不应被简单改成只读默认，导致写任务重新空转。建议区分只读/计划、工作区编辑、自动评审、高权限，明确本轮能做什么。**桥接 scoped 限制的是桥接工具，并不能约束 bypass 模式下 CLI 自带 Bash/文件工具的权限。**

**版本：** 吸收“已验证产品版本 + 协议证据 + 升级回归矩阵”，不必立即捆绑大体积产品载荷。保留我方用户可管理 CLI 的特点，同时对超出已验证范围的版本提示风险。按 DSH 版本选择明确包目标，不能依赖此次仍指向旧版的 npm latest。

**宿主适配：** 可以先在 [host-capabilities](<../src/host-capabilities.ts#L31-L58>) 增加只读 `subagents/subprocess` 能力观测；再单独评估进程 adapter。**接入 `ctx.subprocess` 和改用官方 `ctx.subagents` provider 是两件不同的事**：前者可探索保留自有通道，后者会改任务发布/通知/会话契约。不能把两者合并称为低风险替换。

## 六、不建议直接吸收的内容

1. **不把现有 `dispatch_cli_task` 直接转发成官方 one-shot 工具。** 会改变动态模型、resume、进度、桥接与账本的契约。只有另行设计显式一次性模式才值得评估。
2. **不取消我方无输出超时、重连恢复期限、dedupe 与用量恢复。** 这些是我方已有价值，官方最小 provider 没有对应产品能力不代表不需要。
3. **不照搬产品原生设置为权威。** 官方适合原生账户与设置；我方的 DSH 模型目录及不静默回落策略有自己的明确产品目标。
4. **不为了全局工具曝光引入第二套 CLI 调度入口。** 如增加官方 provider 兼容入口，应先统一任务身份、取消、计费和列表去重，否则会产生双任务/双账本。
5. **不把 ephemeral、不继承父上下文或环境 scrub 当作完整安全隔离。** 它们都不自动限制对同一工作区和外部系统的副作用，也不保证回滚。
6. **不从零重做发布后结构化失败。** 我方已在 [工具边界](<../src/tool.ts#L167-L175>) 保留已创建任务的 `DispatchError.value`；继续强化该契约的测试和诊断即可。

## 七、建议落地路线

| 阶段 | 工作 | 主要影响面 | 完成判据 |
|---|---|---|---|
| 第一阶段 | 环境 scrub、严格终态、关键失败帧矩阵 | [spawn](<../src/spawn.ts>)、[Claude 通道](<../src/channels/claude.ts>)、[Codex 通道](<../src/channels/codex.ts>) | 不泄漏测试宿主变量、不伪成功、原有恢复与 usage/resume 保留 |
| 第二阶段 | 安全诊断分层、最终 cwd 校验、cleanupState | [dispatch](<../src/dispatch.ts>)、[公共诊断](<../src/public-diagnostics.ts>)、[wire 契约](<../src/wire.ts>)、[工具渲染](<../src/tool.ts>) | 父结果无任意 stderr；失效目录不误执行；清理未确认可追踪 |
| 第三阶段 | 权限/版本矩阵、宿主进程 adapter 试验 | [配置](<../src/config.ts>)、[CLI 管理](<../src/cli-manager.ts>)、[宿主能力报告](<../src/host-capabilities.ts>) | 新旧宿主兼容，动态模型、resume、桥接、账本与看板不丢失 |

实施前先补测试，再分小提交改造；不在研究阶段升级依赖、变更默认高权限策略或改版本号。真实产品验证至少覆盖 Windows 与 POSIX、当前已验证 CLI 版本与目标升级版本；计费真实探针应另获授权。

**最终建议：优先做第一阶段。它直接对应当前可核验的安全和正确性缺口，比先切 SDK、换 app-server 或重构整个调度体系更有收益。**
