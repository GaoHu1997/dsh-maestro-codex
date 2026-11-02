# CLI 子智能体安全与宿主兼容边界

## 会话访问不是客户端过滤

CLI 任务的父会话归属来自宿主 `ToolExec.agent.id`。`sessions`/`scope`、任务 ID、资源地址和 CLI sessionRef 只是查询或定位参数，不能授权。

能力只保存在插件当前运行时的内存映射中，**不追加 `maestro/cli-access` 事件，也不写入投影缓存**。`maestroCliAccess` 投影从可信 Session header 取得身份，持久状态只含 `sessionId`；每次 wire view 经宿主已授权的会话读取面交付当前随机 256-bit 能力。能力仅放在 `x-maestro-session-access` 请求头，不放 URL、模型工具参数、任务摘要或 CLI 环境。服务端从能力映射回父身份，再检查任务 owner；过滤参数只能进一步收窄。插件重启、卸载或已绑定 Session 对象替换后旧能力失效。历史事件不能提供身份或恢复授权。

顶部和看板使用宿主提供的当前父身份。多个可见入口分别拥有独立的能力发布生命周期：隐藏或卸载其中一个不能撤销另一个仍存活的同会话入口；旧会话刷新、token 旋转或撤权后的清理不能回退旧凭据。资源 tab 使用当前可信入口发布的能力，绝不按资源 URL 查找别的父会话凭据。缺失宿主授权投影时明确拒绝查看和续发，而非退回无作用域请求。

这不是对宿主全局管理员的隔离：拥有宿主全局会话投影读取权限的插件/客户端属于管理主体，可取得其被授权的会话能力。普通会话工具、普通任务接口与全局管理权限不能混淆。宿主若不对自身 Session 读取建立权限边界，插件无法单独补足该全局边界。

配置页的无 owner npm 安装任务是明确例外。它们可在配置页公开监视，但不是可续发的 CLI 对话。

## 续接与模型

首次派发按真实选定 CLI 的独立最低难度审查；续接沿用原派发准入，不重新按任务关键词选择执行器。续接必须有同一父会话的已结束锚点和有效引用，CLI、cwd 固定；原 CLI 被禁用则明确拒绝，不回落另一执行器。原模型可继承；显式改变模型须经过 DSH 配置解析，不读 CLI 自带模型。

锁按 `(cli, sessionRef)` 而非 `replyTo`，同一真实 CLI 会话的不同历史锚点也不可同时 resume。锁贯穿排队、模型预检、执行和重试，终态释放。运行失败仍保留已收到的文本与有效历史锚点。

Codex `exec resume` 不支持初次 exec 的 `--sandbox` 参数。续接使用等价的 `-c sandbox_mode="workspace-write"` / `read-only` 和 `-c approval_policy="never"` 配置，不能为了续接成功擅自改成 bypass。

## 桥接权限

Skill 全文接口与目录遵守同一允许模型调用策略，撤销后不能靠已知名字直读。工具目录采用当前名称排除表，白名单变化对新调用立即生效。每次执行尝试结束时，在发布成功、失败、超时或取消终态之前同步撤销 token，并中止进行中的宿主调用；自动重试不能沿用上一尝试的 token。配置文件清理的延迟或失败不能延长授权。

宿主工具必须获得可信调用代理及真实、不透明的工具 scope；不能拿 `{agent,cwd}`、CLI 文本或任意对象冒充 scope。宿主未公开该 seam 时工具桥应 fail closed，并显示能力缺失。技能桥可以独立使用。页面续发没有真实调用代理时也不能绕过该限制。缺失 seam 的宿主上，配置为 auto/custom 不等于工具已可执行。

stdio MCP 是直接子进程配置；HTTP MCP 是宿主工具桥接路径，不能把 HTTP URL 写成 stdio command。HTTP MCP 还必须经过有效 scope、宿主策略与 custom 白名单。

生图返回错误必须作为错误投影，并保留工具正文；没有真实 filePath/附件不构造 URL。宿主未提供本地文件/图片打开接口时不能臆造 HTTP 文件端点。

## 公开诊断与端点

公开模型目录中的端点标签删除 URL userinfo、全部 query 和 fragment；真实模型调用仍使用私有解析出的原端点和凭据。预检响应正文仅用于状态与协议分类，不进入公开 detail；网络异常只展示固定白名单错误码或通用说明。宿主工具和技能加载的意外异常、目录发现及暂存失败不向子代理或日志透传原始异常文本。

宿主工具有意返回的结构化失败正文仍遵守其公开输出契约（包括生图失败正文），不会因为脱敏把失败改写为成功。工具正文自身的敏感数据控制由宿主工具负责，不应把它与意外异常回显混为一谈。

## 宿主能力检测

插件用到的每一个宿主服务都是公开接口，但成员会随宿主版本变化。概况接口返回的 `hostCapabilities` 只报告探测结果：每个能力是否解析成功、缺哪些成员、缺失的影响，以及宿主包的版本号（读不到写 `null`）。`permissionContext` 固定记录两件事：宿主工具的可信上下文来自 `agents.get` 返回的真实 Agent 与宿主自己的符号 parent token；地址/查询里的 `sessions`、scope 参数只是过滤条件，**从不**用来取得凭据或提升权限（`scopeParameterTrusted: false`）。

探测是纯只读的 `typeof` 检查加 `package.json` 版本读取：不调用宿主方法、不安装/升级任何包、不改宿主源码，也不以“探测通过”代替真实执行证据。某项能力显示 `absent`/`partial` 时，对应功能按本文其余章节的规则降级或拒绝，而不是放宽边界。

## 用量与镜像

父会话 `maestroCliUsage` 是 CLI 独立账本，不写进父 LLM 标准调用账本。当前宿主 `Session.append` 不保留 `ignorable` 参数，故本插件**不再向 Session 追加 `maestro/cli-usage`**；wire view 合并 canonical 账本、运行时显示镜像和历史兼容记录，按同一用量身份去重。显示镜像不作为持久 checkpoint，原生 `flush` 也不被记作镜像持久化确认；后续原生事件或会话快照会重新计算 wire view。未知 token 桶为 `null`，已知小计单独保留；recent 20 只是明细窗口，累计与幂等 ID 不从 recent 重算。一个 dispatch 的重试实际用量最终累计一次，不同时追加 attempt 明细与 final aggregate 两套账。

插件自有 canonical 账本（`$DSH_HOME/maestro/usage-journal`）是唯一权威：每个 `(owner, usageId)` 一条不可变记录，不随 `recent` 窗口或任务表裁剪，启动/结算前先落盘。CLI 启动前也会写 pending 标记，崩溃后该笔标为未知而不是当成 0。写入走「写临时文件 + 同卷 hardlink 提交」的不可覆盖发布；Windows 目录 fsync 不可用时不承诺掉电一致性。仅同卷、同用户、同进程的并发安全由本插件校验，跨进程原子性依赖宿主实现。

插件通过公开 `maestroCliAccounting` 服务把某个父会话的完整结算历史交给已授权的其他插件/页面；读取必须持有该父会话的宿主能力，`sessionId` 本身不授权，也不提供全局回退。`semantics.requests` 是已结算的 CLI 任务数，不是 provider billable 调用数；`semantics.nativeMirrors` 标明父子是同一笔消耗，统计方不可相加。

CLI child 的 `maestro/cli-child` marker 标明 parent/child/task/usageId/source，标准 tokenUsage 是同一笔消耗的镜像。新建 child 通过公开 `create` seed 保存 **`ignorable: true`** 的只读 marker，结算不再用 `Session.append` 追加私有事件；冷恢复直接持久化的 marker 同样显式标记可忽略。如果结算身份改变而不能匹配只读 marker，则仅保留 canonical 账本，省略会误归属的原生用量样本。统计插件应按该关联去重，不能同时把父自定义账本与子标准投影各加一遍。必填 input/output 或语义未知时不伪造标准 usage；可选 cache 未知时省略，可靠的真实 0 保留。total 只保留 provider 的有效明确值，不编造总额与费用。

宿主重启后的原生镜像恢复使用公开接口：插件自有 `maestroCliRecord` host-only 投影 + `sessionQuery.readSession` + `sessionPersistence.open/create`。只有**同时**满足「公开 query 报确切的 `SESSION_QUERY_SESSION_NOT_FOUND`」「目标物理 generation 不存在」「绑定 identity/epoch 在每次 await 后仍一致」才尝试重建；`stat` 返回 undefined 或 header 损坏都视为未知并跳过，因为二者都不能证明磁盘上没有旧记录。重建只追加 4 条计数观察事件并复用 canonical 的 usageId，不伪造原任务文本、最终答复、catalog 或 Agent；原 prefix、header 与 cut 绝不重写，`flush` 只代表本次写句柄的 barrier，不等于其他第三方统计已读到。无法确认时明确 `skipped` 并保留 canonical，宁可少补也不重复计账。

CLI child 是 `one-shot` 记录，顶部跳转到 CLI 页面而非普通 DSH 回复入口。宿主对 `origin === 'subagent'` 的冷恢复路径本就拒绝 materialize，插件再用 `agent/pre-step` 中间件否决对这类记录的模型请求；这是一次请求级别的拒绝，不保证零 inbox 认领或零 prompt 组装，也不阻止公开 Agent 创建接口被别的调用方使用。普通 fork 出的新 Session 是新的 DSH 执行器，不受该拒绝影响。

Claude 的自动记忆是跨同仓库会话共享的。插件对每个运行进程注入 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`，不改用户 CLI 配置、不清全局记忆、不影响原生 `--resume` 转录。

## 发布验证

单元、fake protocol、jsdom 与 SDK contract 回归不能代替当前 DSH GUI 的真实浏览器验收。构建产物更新也不等于正在运行的宿主和浏览器已加载新版本。没有 `dev:web` watcher 时不得承诺自动刷新；共享宿主重启、插件重载、其他统计插件与真实图像服务验证应受控完成后再放行。
