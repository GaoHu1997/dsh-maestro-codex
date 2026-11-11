# 上线验收提示词 — dsh-maestro-codex

> 用法：把 `---` 之后的全文作为新会话的第一条消息粘贴。它自包含，不依赖此前的对话。正文里所有路径都相对仓库根；不在仓库根时先 `cd`。

---

## 0. 任务

对 dsh-maestro-codex 做上线前验收：仿真测试 + 真机操作测试，找出上线后用户会踩到的 bug；根据测试报告写缺陷修复方案，送独立评审，评审通过后执行修复，再测，循环，直到第 8 节的放行条件全部满足。

结论必须可复核：每个「通过」指向一个证据文件；每个「已修复」指向修复前后的对照证据。拿不到证据的项写 `UNVERIFIED`，不算通过。

## 1. 先核事实（不要照抄本节，自己跑一遍）

```bash
pwd
git rev-parse --show-toplevel
git rev-parse --short HEAD
node -v
node -p "require('./package.json').version"
git log --oneline -5
git status --short
```

期望：仓库根为 `D:\github\dsk-plugin\dsh-maestro-codex`；Node >= 22.19；`main` 为 `lib/index.js`；`type: module`。任何一项对不上，先停下来核清，不要在不匹配的环境上开测。

已勘察的环境（供核对，不是保证，以实测为准）：

| 项 | 值 |
| --- | --- |
| 宿主 | 运行中的 DeepSeek Harness，Web GUI `http://127.0.0.1:12651` |
| DSH 实现 | `D:\devlop\DeepSeek Harness\resources\app.asar\dsh\` |
| 已装插件版本 | 可能落后于仓库源码 |
| shell | Windows + MSYS Bash（不是 WSL，不是 PowerShell 语义） |
| 文件策略 | danger-full-access，但不要跨出第 2 节的红线 |

**验收对象是仓库当前源码构建出的产物**，不是宿主里已装的旧版。部署前先备份宿主里的旧 `lib/`、`locale/`，记录旧版本号，测完给出回滚命令。

## 2. 工作区与红线

证据、脚本、临时 `DSH_HOME`、tarball 一律落在 `release-tests/<YYYYMMDD-HHMM>-acceptance/`（该目录已在 `.gitignore`，不要改 `.gitignore` 把它放进版本库）。

禁止：

- 改 `package.json` 的 `version`；`git push` / `git tag` / `gh release`；发 npm 包。
- 为了让用例变绿而改断言、加 `skip`、删用例、改基线 JSON、放宽阈值、改被测代码之外的 mock 使其配合错误行为。
- 手改 `lib/`（它是 `npm run build` 的产物；改源码后重建）。
- 把 mock/stub 的结果写成真机结果，或用「应当」「等价于」代替实测。
- 降低难度门槛、放宽路由规则来让派发测试通过。
- 写操作员真实配置：`~/.claude/settings.json`、`~/.codex/config.toml`、`~/.grok/`、`$DSH_HOME/.credentials.yaml` 只读；grok 共享 home 的租约/配置改写测试必须在隔离的 `GROK_HOME` 下做。

必须先备份再动：宿主插件目录、`$DSH_HOME/maestro/`（`effects.json`、`tasks/`、`usage-journal/`、`grok-home/`）、`npm ls -g --depth=0` 快照。真机装/卸 CLI 后按快照恢复，并在报告里列出恢复结果。

## 3. 证据分级

| 级别 | 含义 | 手段 |
| --- | --- | --- |
| E0 | 静态与单元/集成 | `npm run typecheck`、`npm test`（vitest，`tests/**/*.test.ts{,x}`，共 123 个文件，其中 7 个 `upstream-*`），逐条读断言，不只看绿 |
| E1 | 仿真 | stub CLI（`tests/fake-child.ts` 模式）、隔离 `DSH_HOME` 与临时 cwd、真实 HTTP 路由（`/overview` `/health` `/status` `/prompts` `/config-history` `/task/reply`）、jsdom 客户端渲染 |
| E2 | 真机 CLI | 真实 claude / codex / grok 进程、真实 `npm -g` 安装卸载、真实会话与 resume |
| E3 | 真实部署 | `npm pack` 出 tarball，装进运行中的 dsh，从 GUI 与 HTTP 面确认用户看到的行为 |
| E4 | 用户视角 | 假设自己没读过源码：按 README 从零配一遍、派一次、看结果，记录卡点 |

规则：低级别不能顶替高级别；同一用例只记最高级别；未执行的写 `UNVERIFIED` 并说明为什么。

## 4. 验收矩阵（逐项给判定，不准合并成「均正常」）

### 4.1 安装与生命周期

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| L1 | 从源码构建 | `npm run build` 成功，`lib/index.js` 与 `lib/client.js` 更新 | E0 |
| L2 | `npm pack` 内容 | 只含 `files` 白名单：`lib`（无 `.map`）、`cordis.patch.yml`、README/LICENSE/icon、`locale/*.json`、指定的 6 个 docs、3 个 scripts + `scripts/lib/session-artifact-runtime.mjs`、THIRD_PARTY_NOTICES；无 `src/`、`tests/`、`node_modules/` | E1 |
| L3 | 干净安装 | 空目录装 tarball，`lib/` 可被宿主加载，`client` 导出为 CJS factory | E3 |
| L4 | 升级 | 旧版→新版覆盖，配置保留，`/overview` 版本号变化，任务表不重复 | E3 |
| L5 | 禁用/卸载 | 禁用后不再注册 `dispatch_cli_task` 与路由；卸载后残留文件可列出 | E3 |
| L6 | 安装目录跑 `scripts/maestro-status.mjs` | 不依赖源码/开发依赖，`--json` 输出可解析 | E3 |

### 4.2 配置面

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| C1 | 默认值 | 新装后各 CLI 门槛=中、超时、并发、`injectGitContext` 等默认值与文档一致 | E1 |
| C2 | 热生效 | 改门槛/权限/模型后无需重启即生效 | E1 |
| C3 | 非法值 | 超时 `0`/`241`、并发 `0`、`prepareCommand` > 4000 字符被拒且提示可读 | E1 |
| C4 | 配置页渲染 | jsdom 下各分组可展开、折叠、保存，无 React 警告 | E1 |
| C5 | 配置历史 | `GET /config-history` 脱敏（无 token/密钥明文），仅记录变更 | E2 |
| C6 | 提示模板 | `GET /prompts` 返回默认模板，`POST /prompts/save` 后标 `stale`，改动可回滚 | E2 |

### 4.3 派发决策与门槛（本插件的核心，必须做反例）

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| D1 | 低难度任务 | `low` 低于门槛 → 不启 CLI，走 dsh 子代理（`subagent`/`subagent_fork`）或主代理自办 | E2 |
| D2 | 显式 `cli` 绕门槛 | 传 `cli:"codex"` 但难度不足 → `RoutingError`，无 CLI 进程启动 | E2 |
| D3 | 难度理由缺失 | 空 `difficulty_reason` → 拒绝或按 `low` 保守处理，行为与文档一致 | E1 |
| D4 | 类型路由 | 13 个内置类型落到配置页分配的 CLI；旧名称仍映射 | E1 |
| D5 | 幂等 | 同父会话 + CLI + 任务名 + cwd，10 分钟内第二次被拒 | E2 |
| D6 | 派发理由可查 | 一次真实派发能在结果/事件流里看到「为什么派给这个 CLI」的决策痕迹 | E2 |
| D7 | 结果回填质量 | 抽 3 次真实派发人工核对：结论与证据一致、覆盖验收标准全部条目、未把猜测写成事实、数字（token/耗时）能对上 | E2 |

### 4.4 执行器（每通道四类：成功 / 失败 / 取消或超时 / resume）

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| X1 | claude 成功 | 任务文本走 stdin，`stream-json` 解析，`finalText` 非空，取到 sessionId | E2 |
| X2 | claude 权限 | `default` 拒写、`acceptEdits` 放行、`bypassPermissions` 放行，任务不挂死 | E2 |
| X3 | codex 成功 | `exec --json` 解析，threadId 取到 | E2 |
| X4 | codex 沙箱 | `read-only` 拒写、`workspace-write` 放行 | E2 |
| X5 | codex 保真 | 含引号/空格的 `-c` 覆盖逐字节核对；Windows shim 经 node 直启 | E2 |
| X6 | grok 成功 | `streaming-messages-json` 解析，`GROK_HOME` 隔离，`~/.grok` 不被写 | E2 |
| X7 | grok 无密钥 | 报错指向凭据，不挂死，不留租约 | E2 |
| X8 | 协议不匹配 | 如 anthropic 主代理 + codex 且配置页未选模型 → spawn 前失败并列出原因 | E2 |
| X9 | 模型预检 | 端点不认该模型 → 报供应商+模型，CLI 不启动一半 | E2 |
| X10 | 无输出超时 | 静默超过窗口 → `failed(timeout)`，进程树被杀，无残留 node/claude/codex 子进程 | E2 |
| X11 | 预警 | 窗口剩 1/5（≤2 分钟）时事件流预警，恢复输出后重置 | E1 |
| X12 | 取消 | 取消 → `canceled`，进程树被杀，账本记实际消耗 | E2 |
| X13 | resume | 三通道各一次：`--resume`/`exec resume`/`-r`，答出上一轮事实，`replyTo` 链正确 | E2 |
| X14 | resume 并发 | 同一会话链第二条回复 → 409 或锁定 | E2 |

### 4.5 桥接

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| B1 | 技能桥 | 任务文本含技能目录；`skill_<name>` 经 MCP 取到全文；`disable-model-invocation` 与 `*.disabled` 不可见 | E2 |
| B2 | claude 原生技能 | `claudeSkillsMode:native` 生成暂存树（SKILL.md + `when_to_use`），结算后清理；失败回退桥模式 | E2 |
| B3 | 宿主工具桥 | `off/auto/scoped/custom` 四档行为正确；auto 排除表生效；scoped 的 12 项白名单与 agent 可见工具取交集；父/子 cwd 不同时，相对读取、默认搜索根与 `path/to` 复制仍只操作子目录；`../`、绝对越界与链接逃逸拒绝且未执行；旧 scoped token 不随切到 custom 放宽，异步解析期间撤销仍阻止执行；安装构建与 live 模式另行核验 | E2 |
| B4 | 桥接鉴权 | 一次性 token 结算即作废；缺可信代理/工具 scope 时明确拒绝 | E1 |
| B5 | MCP 子进程环境 | stdio 子进程不继承模型凭据，只还原声明的 env；argv/TOML/log 无明文密钥 | E2 |

### 4.6 可观测

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| O1 | 任务监视 | 只显示 `dispatch_cli_task` 任务，带 CLI 徽标，进度/取消/超时/并发可用 | E3 |
| O2 | 任务看板 | 装了 better-sidebar 时出现 tab；树/图切换、折叠、详情、CLI 节点挂接与去重正确 | E3 |
| O3 | CLI 会话页 | 气泡回放、多轮 `replyTo` 串接、底部续发、token 与缓存命中显示 | E3 |
| O4 | 用量账本 | `$DSH_HOME/maestro/usage-journal` pending→settled；未知桶为 null；resume 只计增量；codex inclusive 扣缓存 | E2 |
| O5 | 结果落盘 | `$DSH_HOME/maestro/tasks/<taskId>.json` 含摘要/最终文本/事件尾；重启后恢复最近 40 条 | E2 |
| O6 | 健康与状态 | `/health` 七个单写者条目；`/status` 阶段计数与待处理副作用；`maestro-status.mjs` 与 HTTP 一致 | E2 |
| O7 | 原生记录镜像 | `cli-<taskId>` 子记录 + `mode:'one-shot'` 目录行 + `session/title`；旧记录兼容；不登记宿主 jobs | E2 |

### 4.7 可靠性

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| R1 | effects 队列 | 派发前落 `launch`，同键覆盖，5s→300s 退避，三连败进健康面板 | E1 |
| R2 | 重启恢复 | 杀进程留下的行 → `interrupted`，终态不计失败，可重派 | E2 |
| R3 | `prepareCommand` 失败 | 任务 `failed` 且**未启动 CLI** | E1 |
| R4 | `failureRetries` | =1 时真实重试一次（usageAttempts=2）；超时与取消永不重试 | E2 |
| R5 | 并发上限 | =1 时第二任务排队后执行，不丢事件 | E2 |
| R6 | git 上下文 | 有未提交改动的仓库，任务文本含只读 git 快照段 | E1 |
| R7 | 阶段派生 | `person/answer · person/review · person/blocked · person/failed · working/queued · working · idle` 与场景一致 | E2 |

### 4.8 安全与降级

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| S1 | 会话授权 | 只有持有父会话宿主能力才能读会话/账本；地址里的 `scope` 从不参与授权 | E1 |
| S2 | 宿主能力缺失 | `sessions`/`sessionProjections` 缺失 → fail closed，报告 `degraded` 与实际影响，不放宽权限 | E1 |
| S3 | 版本报告 | `/overview` 的 `hostCapabilities` 列出各成员解析结果与真实版本号，读不到为 null 而非编造 | E2 |
| S4 | 客户端入口 | 无当前父会话能力时页面拒绝而非换执行器 | E1 |
| S5 | 日志卫生 | 会话日志/控制台/事件流无密钥、无 token 明文 | E2 |

### 4.9 兼容与本地化

| ID | 用例 | 预期 | 最低级别 |
| --- | --- | --- | --- |
| K1 | peer 范围 | 当前宿主版本落在 `peerDependencies` 范围；边界版本行为记录 | E2 |
| K2 | Node 22.19 | 用最低支持 Node 跑 `npm test` 关键子集 | E1 |
| K3 | Windows 路径 | 含空格/中文路径的 cwd 派发成功 | E2 |
| K4 | 双语 | `locale/zh.json` 与 `en.json` 键集一致，缺键回退不抛错 | E1 |

### 4.10 用户视角走查（E4，必做）

按 README 从零走：装 → 打开配置页 → 选模型 → 派一个真实任务 → 看结果 → 续发 → 看板/会话页 → 卸载。记录每个需要翻文档才能完成的步骤、看不懂的错误信息、误导性默认值。这类问题按 4.11 分级，UX/默认值陷阱按 `major` 起。

## 5. 子代理派发纪律（本次验收自身也要守，同时是 D 组的被测对象）

### 5.1 派发前三问，答不上来就不派

1. 为什么必须用子代理？单个 agent 用现有工具做不到的才算（跨模块并行、独立评审、真机矩阵并行）。读一个文件、跑一条命令、改一处文案，自己干。
2. 为什么是这个 CLI？按能力匹配：仓库探索/影响分析/方案设计/文档 → claude；功能开发/测试验证/代码审查 → codex；缺陷修复/数据处理 → grok；找不到匹配或任务太轻 → dsh 子代理。
3. 为什么是这个难度？按真实范围写 `difficulty_reason`（步骤、依赖、风险），不按关键词抬档，也不为省事压档。低于门槛就换 dsh 子代理，不换门槛更低的 CLI 绕。

### 5.2 任务必须自包含

每个派发写全：目标、绝对路径、要改/要看的具体文件、验收标准、输出格式、证据落盘路径、不要做的事（改测试/改版本/发版）。子代理看不到本会话，缺一项就会跑偏。

### 5.3 结果验收，不采信自述

子代理回传必须带证据路径与原始输出片段。主代理抽查重放，三档结论：

- `verified` — 证据可重放，结论与证据一致。
- `contradicted` — 证据与结论冲突，或复跑失败。
- `unverified` — 只有结论没有证据，或证据路径不存在。

`unverified` 不计入通过；`contradicted` 计入缺陷。两个子代理结论冲突时，以可重放的原始证据为准，不以措辞更自信的一方为准。

### 5.4 并行与资源

互不依赖的用例可并行；共享同一 CLI home、同一端口、同一 `DSH_HOME`、同一 npm global 的测试串行。真机 CLI 测试与本地 `npm test` 同时跑要限并发（vitest 已设 `maxWorkers: 2`），否则超时会被误判为产品缺陷。

### 5.5 派发台账

`release-tests/<ts>-acceptance/dispatch-ledger.md` 一张表：时间 / 子代理 / CLI / 难度 / 理由 / 任务摘要 / 证据 / 结论（verified·contradicted·unverified）。报告第 2 节直接引用这张表，让「派发是否合理」可被外部复核。

## 6. 测试报告

路径 `release-tests/<ts>-acceptance/acceptance-report.md`，固定章节：

1. 基线与最终结论（起始 commit、最终验证 commit、版本号、环境、tarball sha256）
2. 子代理派发台账（含每条派发的合理性与结果核验结论）
3. 矩阵明细：一行一个用例 `ID | 预期 | 实际 | 证据路径 | 级别 | 判定`
4. 缺陷清单（按 7.1 分级，每条指到 `文件:行` 与证据）
5. 修复轮次记录（round-N：报告 → 方案 → 评审 → 修复 → 回归）
6. 未覆盖与风险（`UNVERIFIED` 项、为什么、影响面）
7. 放行判定（第 8 节 checklist 逐条打勾）

计数自洽：通过数 + 失败数 + `UNVERIFIED` 数 = 用例总数；每个「通过」都能在证据目录里找到文件。

## 7. 缺陷闭环

### 7.1 分级

| 级别 | 定义 |
| --- | --- |
| blocker | 装不上/启动失败/派发不可用；密钥或会话越权泄漏；数据损坏（账本、会话日志）；崩溃或挂死；用户无法完成任务 |
| major | 主路径可用但有明显错误：结果解析错、resume 接不上、门槛可绕过、超时不杀进程、UI 关键信息错、默认值导致用户踩坑 |
| minor | 文案、错别字、罕见边界、样式偏差、日志噪音 |

### 7.2 修复方案模板（每个缺陷一份，写完再动手）

- 现象与证据（命令 + 输出/文件路径）
- 根因（指到 `src/xxx.ts:NN`，说明为什么此前没被发现）
- 影响面（哪些通道/平台/配置组合）
- 改法（关键代码点，为什么不选另一种）
- 被否决方案及原因
- 回归用例（新增/修改的测试文件与用例 ID）
- 回滚方式（单 commit 粒度）与风险

### 7.3 评审 gate（必须由未参与该修复的子代理做）

逐条回答，任一不通过即 `reject` 并给出具体条目：

1. 根因有证据支撑，还是「可能」「大概」？
2. 改法是否只修正被测行为，有没有按用例输入特判？
3. 是否先有失败用例（先红后绿）？
4. 是否放宽了任何旧断言、加了 `skip`、改了基线/阈值？
5. 是否影响其他通道、平台、配置组合（尤其 codex 沙箱、grok 租约、claude settings 覆盖）？
6. 回滚是否可执行？
7. 是否有用户可见行为变化需要在报告中说明？

评审结论写入报告第 5 节。`reject` 的方案改完重新送审，不得跳过评审直接修。

### 7.4 修复纪律

一个缺陷（或一组同根因）一个 commit；先写失败用例再修；修完必须跑：`npm run typecheck` + 全量 `npm test` + 受影响的 E1/E2 用例；禁止顺手重构无关代码。

### 7.5 循环

每轮：完整测试 → 报告 → 缺陷方案 → 评审 → 修复 → 回归 → 新一轮报告。轮次编号 `round-1..N`，每轮保留修复前/后证据。同一阻塞原因连续 3 轮无法推进就停下写清阻塞点，不要靠放宽标准「通过」。

## 8. 放行条件（全部满足才算通过）

- [ ] blocker = 0，major = 0
- [ ] `npm run typecheck` 通过
- [ ] 全量 `npm test` 通过，且没有新增/残留 `skip` 与放宽断言
- [ ] E1 仿真矩阵全绿
- [ ] claude / codex / grok 三通道各有至少一次 E2 真实成功 + 一次真实失败路径（报错可读、无残留进程）
- [ ] 至少一次 E3 真实部署：tarball 装进运行中的 dsh，GUI 关键路径（配置页、任务列表、看板、CLI 会话页、续发）实测通过
- [ ] 报告里没有 `UNVERIFIED` 的 blocker/major 用例
- [ ] 候选 tarball 的 `files` 白名单核对通过，sha256 记录在报告里
- [ ] 环境已恢复：npm global 回到快照、`$DSH_HOME/maestro/` 与用户 CLI 配置无意外改动

## 9. 汇报与停止

每轮结束给四行，不刷屏，长输出落文件：

```text
本轮发现：n 个（blocker a / major b / minor c），新增用例 x
本轮修复：n 个，commit <hash>
回归结果：typecheck ok/er，npm test n/n，E2 通道通过 n/3
阻塞：无 / 具体原因
```

不要为了推进请求更大权限（当前已是 danger-full-access）；不要用「已确认」「应当没问题」代替实测；不要在报告里写没有证据的结论。
