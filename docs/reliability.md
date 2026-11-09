# 可靠性面

这组机制来自对 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的工程骨架借鉴（对照方案见 [设计记录](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/docs/plan-borrow-from-superagent.md)）。对方假设"外部世界会失败"：GitHub 会 502、进程会被重启、模型会重试。本插件同样是外部执行者——CLI 子进程、网关、宿主 seam 都会断——所以只抄这几层骨架，不抄它的产品概念（Source / Ticket / Eval / Mandate）。

## 1. 持久化副作用队列（`src/effects.ts`）

一次派发在 spawn 之前往 `$DSH_HOME/maestro/effects.json` 落一行 `launch`：

```json
{ "kind": "launch", "key": "task-…", "value": { "cli": "claude", "prompt": "…", "cwd": "…" }, "attempts": 0, "due": 0 }
```

- 同 `kind + key` 只保留一行（重复入队会 `generation + 1` 并重置尝试次数，旧代的 `settle/fail` 直接失效）。
- 失败按 `5s → 10s → … → 300s` 退避，连续 3 次记 `error` 并写入健康面板（`effects` 条目），不再重试。
- 任务走到任意终态就 `settle`，把行清掉；`drain()` 关闭时只停写不删行——崩溃留下的行才是下次启动要解释的东西。

它不是"重启后自动重跑"：重跑外部 CLI 可能重复改文件，代价比看懂一句"上次没跑完"高得多。所以它负责**留下痕迹**，恢复语义交给下一节。

## 2. 重启恢复：`interrupted` 阶段

`MaestroPhase` 新增 `interrupted`：**终态，但不是失败**。没有结论、没有退出码，只是"进程死了"。

启动时 `restoreInterrupted` 读取队列里还挂着的 `launch` 行，按 tasks 的标题/cwd/cli 重建一条 `interrupted` 任务，事件流里写明"已中断：上次退出时这个任务还没跑完"，然后把行 settle 掉。

看板上的表现：阶段显示「已中断」，`stage` 是 `person/answer`（**等你决定要不要重新派发**），而不是 `person/failed`（去看错误原因）。恢复任务不带着跑，因为上一次跑到哪一步只有人知道。

## 3. 幂等键（`src/dedupe.ts`）

同一父会话、同 CLI、同任务名、同 cwd 在 **10 分钟**内重复派发，第二次直接抛 `DuplicateDispatchError`，不 spawn。模型可以显式传 `dedupe_key` 覆盖隐式键（比如按 PR 号去重），续接（`resume`）不参与去重——同一会话多轮往返本来就该重复。

失败会立刻 `release` 键：**没跑起来的不占窗口**，否则一次网关抖动会把重试锁死 10 分钟。

## 4. 健康面板（`src/health.ts`，`GET /health`）

七个单写者条目：`dispatch / spawn / effects / persist / bridge / native-mirror / preflight`。每条只有 `ok | degraded | error` 和一句中文影响说明，`claim(name)` 只允许一个持有者（重复认领会抛错），未认领的条目不出现在面板里——**健康态不占空间**。

顺序固定按声明序，不按时间排：面板刷新两次，条目位置不该跳动。`worst()` 给整体结论，`problems()` 只给需要看的。这取代不了已有的 `hostCapabilities` 报告（那个讲宿主版本差异），两者并列。

## 5. 阶段派生（`src/stage.ts`，`GET /status`）

`phase` 说的是任务走到哪一步，`stage` 说的是**现在需不需要人**：

| stage | 什么时候 |
| --- | --- |
| `person/answer` | 结构化收尾要你回话；中断的任务也在这里 |
| `person/review` | 跑完了，等你看结果 |
| `person/blocked` | 它说自己被卡住了 |
| `person/failed` | 失败或超时，要你决定 |
| `working/queued` | 排队等槽位 |
| `working` | 正在跑 |
| `idle` | 已结束且不需要人（也含 npm 安装作业） |

`GET /status` 给出七个计数的快照、`needsPerson` 总数、`pendingEffects` 与 `problems`，作为 `maestro status` 脚本的机器可读来源。

## 6. 结构化收尾（`src/result-protocol.ts`）

派发时在任务末尾追加一行说明，CLI 可以用一行 JSON 交代自己的状态：

```
MAESTRO_RESULT {"state":"blocked","human_action":"确认线上库能否直连","summary":"卡在权限"}
```

- 只回扫最后 40 行，坏行继续往前找，读不到就当没说——**绝不从自由文本里猜**。
- `state ∈ progress / waiting / ready / blocked / failed / dropped / unknown`；提示写 `ready`/`blocked` 才影响 `stage`。
- 结果是展示层信息：写进看板详情与事件流，**不改工具输出契约**（工具仍返回 `finalText`），老模型不写协议行时退回 `fallbackResult(phase)`。

## 7. 就绪命令（`prepareCommand`）

配置项 `prepareCommand`（默认空，≤4000 字符）在 spawn CLI 之前于任务 cwd 跑一次，典型用途是 `git worktree add`。超时 10 分钟，输出截断到 2000 字符；失败直接让本次派发 `failed` 且**不启动 CLI**——前置条件没谈成，跑起来只会踩同一个坑。

## 8. 配置历史（`src/config-history.ts`，`GET /config-history`）

每次配置生效（`effectiveOf` 的扁平化结果）与上一次签名不同时记一条快照，保留 50 条，30 秒内重复轮询不追加。差异码只有五种：`enabledOn / enabledOff / cliEnabled / cliDisabled / fieldChanged`。

密钥先过 `redactEffective` 再入历史，历史文件里不会出现 token 明文。

## 9. 提示模板（`src/prompts.ts`，`GET /prompts`、`POST /prompts/save`）

三段可由人改写的文本：`resultProtocol`（结构化收尾说明）、`routingHint`（写进主会话系统提示的路由建议）、`replyPrefix`（续接指令前缀）。每条记录出厂正文的指纹（`base`），出厂默认改动后旧覆盖会标 `stale`——**显式告诉你"默认更新过了，你那份可能过期"**，而不是偷偷沿用。

## 10. `maestro status`

```bash
node scripts/maestro-status.mjs             # 打一份人看的快照
node scripts/maestro-status.mjs --json      # 机器读
node scripts/maestro-status.mjs --url http://127.0.0.1:11061
```

读 `GET /plugin/dsh-maestro-codex/status`，退出码 **0** 无健康问题 / **1** 连接、HTTP 或 JSON 读取失败 / **2** 存在 `degraded` 或 `error` 健康条目。脚本随安装包交付，只依赖 Node（与插件相同的 `>=22.19`，使用内置 `fetch` 与 `AbortSignal.timeout`），不依赖其他 `scripts` 或源码。请在安装包目录执行；`--url` 或 `MAESTRO_WEB_URL` 应指向正在运行的真实 DSH 地址，示例端口不保证与当前宿主相同。

## 11. CLI 重连与进程收尾

CLI 的 `timeout_minutes` 仍表示连续无 stdout/stderr 输出超时，任意非空输出分片会续期，不限制正常任务的总运行时长。Codex 另有同长度的持续重连期限：从首次明确的 `Reconnecting` 诊断开始，重复重连、普通 stderr、空白或未知 JSON 帧均不会续期；识别到任务执行、文件变更、推理、答复或完成帧时解除重连期限，后续再次断线重新计时。到期请求终止 CLI，返回 `stats.timedOut=true` 和 `stats.reconnectTimedOut=true`，由派发层记录为超时；不触发自动重试，也不把内部恢复超时误报为用户取消。

CLI 与就绪命令共用有限的进程收尾：收到 `exit` 后最多保留 5 秒读取管道尾部；超时或取消后先设置 6 秒的收尾期限，再请求终止进程。重复输出不会延长这些期限。正常 `close` 会结算真实退出码；期限届满仍未收到 `close` 时，刷新已收到的尾行、关闭本地管道并返回失败（退出码 `null`），明确提示进程终止或输出完整性未确认。父进程已退出时不会对旧 PID 盲目执行树杀。

Claude 与 Grok 通道复用同一条恢复期限（`src/recovery-budget.ts`）：首个 `Reconnecting` / `Retrying` / 网络错误诊断起算，重复诊断不续期，解析到真实协议帧即解除；到期同样记 `timedOut` / `reconnectTimedOut`，不当作取消。

## 12. 宿主侧等待与桥接收尾

CLI 之外的宿主调用同样不能无限等待——它们没有进程可杀，旧实现遇到不响应 `AbortSignal` 的实现或卡住的文件系统会永远挂起，工具调用一样不返回。`src/deadline.ts` 的 `awaitWithin` 只保证「等到期限就返回」，并把同一个 signal 继续往下传；底层晚到的结算只被消费，不会变成未处理拒绝，也不表示底层副作用已被物理终止。

- 桥接（`src/bridge.ts`）：技能目录发现 20 秒、技能读取 20 秒、宿主工具执行 10 分钟、原生技能清理 30 秒。发现超时按空目录继续；读取/执行超时返回 504 并说明底层可能仍在运行；鉴权（401）与脱敏（500）语义不变。
- 派发收尾（`src/dispatch.ts`）：启动记账 30 秒、结算/清理 30 秒、取消后结算冲洗 5 秒。开始用量记账超时会按失败关闭本次派发；结算用量超时仍保留已完成的结果，只把记账标为未确认并给出告警，不重试、不伪造 `0`。
- `dsh_bridge` 垫片（`src/bridge-shim.ts`）：单次请求的 fetch 与响应体共用一个期限（目录 20 秒、工具调用 15 分钟），响应头到达不等于响应体到达；stdin 关闭时中止所有在途请求，并在最多 2 秒的冲洗窗口后退出，不再等待绝不返回的 HTTP 调用。
- Grok 运行前的文件系统步骤（`src/channels/grok.ts`）：会话目录准备、`config.toml` 写入、跨进程 `.maestro-run.lock` 租约获取与清理各 30 秒。超时按失败处理（不会带着未确认的租约硬跑），finally 仍会释放进程内 home 门锁，避免同目录队列被永久占住。Claude 的一次性 settings 文件清理有 5 秒上限，清理超时不会掩盖已完成的运行结果。
- MCP 环境垫片（`src/mcp-env-shim.ts`）：收到 SIGINT/SIGTERM 后转发给 MCP 子进程，5 秒内仍未退出则升级 SIGKILL；子进程退出即以它的退出码结束垫片，避免继承的 stdio 让垫片在取消后继续存活。

## 兼容性

- `stage` / `result` 是摘要上的**新增可选字段**，老客户端忽略即可。
- `interrupted` 是新阶段：新客户端显示「已中断」，老客户端会落到未知分支，但不会崩。
- 落盘文件都带 `version` 字段，读到未来版本时按"不认识的当空"处理并 `warn`，不抛。

## 发布资产的失败恢复

当前发版先发布 npm，再创建 GitHub Release / 上传资产。如果 npm 已成功而 GitHub 步骤失败，**不要盲目重跑整条发布任务**：同版本再次发布会被 npm 拒绝，无法推进到上传阶段。

1. 保留失败运行生成的原始 tarball；不要另行重建替代它。
2. 核对 tag 对应的提交、包名和版本；用官方 registry 查询已发布版本的 `dist.integrity`，与原始 tarball 的 SHA-512 完全一致才继续。
3. 确认 GitHub Release 是不存在，还是已存在但缺少资产。权限、认证或网络错误不能当成“不存在”。仅恢复创建/上传步骤，不重新执行 npm publish。

```bash
# 在失败运行的精确 tag checkout 中执行；artifact 指向那次运行保留的 tarball。
set -euo pipefail
name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')
artifact="./dist/$name-$version.tgz"
tag="v$version"
git rev-parse --verify "$tag"
actual=$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write("sha512-"+crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$artifact")
published=$(npm view "$name@$version" dist.integrity --registry=https://registry.npmjs.org/)
test "$actual" = "$published"
# 确认 Release 不存在时执行：
# gh release create "$tag" "$artifact" --verify-tag --title "$tag" --generate-notes
# 确认 Release 已存在时执行：
# gh release upload "$tag" "$artifact" --clobber
```

这是显式资产恢复路径，不意味着发布工作流自动具备跨 npm / GitHub 的事务回滚或重跑幂等性。恢复命令需要操作者已有的正式权限；验收测试不执行这些发布操作。

## 测试

都是常规 vitest，跟源码同层：

| 文件 | 覆盖 |
| --- | --- |
| `tests/effects.test.ts` | 去重、退避、三连败进死信、`drain` 保留未完成行、坏文件容错 |
| `tests/dedupe.test.ts` | 隐式/显式键、窗口、失败释放、容量上限 |
| `tests/health.test.ts` | 单写者、固定顺序、`worst/problems` |
| `tests/stage.test.ts` | 15 组 (phase, result) → stage 映射 |
| `tests/result-protocol.test.ts` | 窗口、坏行回退、截断 |
| `tests/recovery.test.ts` | 队列行 → `interrupted` 任务 |
| `tests/prepare.test.ts` | 平台 shell、非零退出、超时、输出截断 |
| `tests/config-history.test.ts` | 扁平化、密钥脱敏、debounce、保留条数 |
| `tests/prompts.test.ts` | 覆盖、`stale` 检测、复位、长度上限 |
| `tests/dispatch-effects.test.ts` | 端到端：入队/结算、收尾解析、去重、人优先槽位、就绪命令失败 |
| `tests/routes-reliability.test.ts` | 四个新路由的状态码与返回形状 |
| `tests/persist-reliability.test.ts` | `result` 与 `interrupted` 的落盘/读回 |
| `tests/task-registry-reliability.test.ts` | 中断任务的终态语义、npm 作业落 `idle` |
| `tests/limiter-priority.test.ts` | 人优先、溢出槽、abort、容量变更 |
| `tests/deadline.test.ts` | `awaitWithin` 成功/超时/取消/晚结算/同步抛出 |
| `tests/recovery-budget.test.ts` | 首个重连起算、重复不续期、进展解除、到期中止 |
| `tests/codex-reconnect.test.ts` | Codex 重连期限：杂音不续期、恢复、取消竞态 |
| `tests/claude-reconnect.test.ts` | Claude 重连期限：持续诊断终止、真实帧后保留 idle 保护 |
| `tests/process-close.test.ts` | 进程收尾：超时/取消无 close 有界、尾行刷新、prepare 镜像 |
| `tests/bridge-shim-bounds.test.ts` | 垫片请求/响应体期限、EOF 中止、notifications/cancelled |
| `tests/dispatch-io-bounds.test.ts` | 启动/结算宿主 IO 永不返回时的有界返回与资源释放 |
