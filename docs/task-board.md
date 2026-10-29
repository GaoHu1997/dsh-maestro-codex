# 任务看板（右侧栏 tab）

一个 tab 里同时看三类「正在进行的事」：DSH 会话树（主任务 + 各级子代理）、CLI 子代理（`dispatch_cli_task` 派发）、DSH 后台任务（jobs）。

## 座位

不是 DSH 内核的右侧栏 tab，而是第三方插件 `dsh-better-sidebar` 的扩展点：它在 `client/index.tsx` 里 `ctx.provide('betterSidebar', service)`，我们对它 `ctx.inject(['betterSidebar'], …)` 再 `registerTab({ id: 'maestro-board', title: '任务看板', order: 45, single: true, component })`。

- `betterSidebar` 是**可选**服务：没装那个插件时注入回调永远不触发，看板不存在，其余功能不受影响；所以它不在插件的 `inject` 声明里（那会让整个客户端 half 加载失败）。
- `single: true` = 全局一个实例（多点几次不会开第二个）。
- 重复 `registerTab` 会抛错（热重载两次 `apply` 时可能遇到），`register.ts` 捕获后只打一条 `console.warn`。

## 数据从哪来

| 区块 | 数据源 | 备注 |
| --- | --- | --- |
| DSH 会话树 | `ctx.sessions.list` 的 `byId[scope.sessionId]`（根）+ `byId[*].parentId` + `projectionsBySession[*].values.subagentCatalog` | 两边取并集：目录只记直系，血缘补充漏网的子级；渲染成可折叠的缩进树 |
| CLI 任务 | 本插件的 `GET /plugin/dsh-maestro-codex/tasks?sessions=<id,…>`、`.../task-detail?id&cursor&sessions=…`、`POST .../task-cancel`（body `{id, sessions}`） | 2.5s 轮询列表、900ms 轮询展开项日志；`sessions` 传当前会话树的 id 集合，任务归属由 `dispatch_cli_task` 的 `exec.agent.id` 决定 |
| 后台任务 | `ctx.jobs`（`state.getSnapshot/subscribe`、`watchRows`、`observe`、`kill`） | 按树上的会话 id 逐个 `watchRows`，客户端去重合并 |

全部是**客户端已有 feed**，不新增 host 路由，也不改 `src/wire.ts` 的契约。

## 用量对账

CLI 子代理的 token 与请求记录不在 dsh 的 token 账本里（那本账只记 dsh 自己发出的模型调用），所以插件在 `src/usage.ts` 里补一条独立的记录面：

- 每次 `runDispatch` 结束，`reportCliUsage` 向**所属会话**（`exec.agent.session`）追加 `maestro/cli-usage` 事件，payload 是该次调用的 `CliUsageRecord`（CLI、模型、阶段、退出码、起止时间、四类 token）。
- 插件同时向 `ctx.sessionProjections` 注册 `maestroCliUsage` projection（`stateVersion: 1`），把事件累加成 `{ totals, recent }`（最近 20 条）。
- dsh 与其他插件读 `projectionsBySession[sessionId].values.maestroCliUsage`；插件自身也可以 `ctx.sessionProjections.stateOf(session, 'maestroCliUsage')` 直读。
- 之所以不用 `assistant/message` / `assistant/attempt`：前者会进对话 surface，后者会被 dsh 的 `addReplacing` 当成同一 turn/step 的样本**替换**主模型用量，且会让客户端 turn-tail 的 attempt 聚合状态机变成 invalid。自定义事件两条路都不碰，宿主升级也不会冲突。

## 降级

- 没有 `sessions` 服务 → 树退化成「当前会话」一个节点，其余区块照常。
- 没有 `jobs` 服务 → 后台任务区块显示空态，不报错。
- `subagentCatalog` 里 `mode: 'external'` 的行（CLI 子代理没有本地 Session）会画成**幽灵行**（斜体、无跳转），因为点进去没有会话可开。
- 树节点默认全展开；折叠三角只收子树，点标题才进会话（`ctx.get('workspace').openSession`，退化到 `sessions.open`），external 节点两种手势都不做。
- 血缘数据理论上可能有环，`buildSessionTree` 用 `visiting` 祖先链剪枝，重复 id 不会再展开。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/client/board/model.ts` | 纯函数：建树、摊平、按筛选剪枝（`filterTree`）、状态映射、格式化。**不 import React**，单测直接跑 |
| `src/client/board/data.ts` | hooks：会话 feed、作业名册 + 观察、CLI 列表/详情轮询、每秒 tick |
| `src/client/board/Board.tsx` | 组件 + CSS（token 走 `--dsh-*`，注入一份 `<style>`，幂等）；`TreeNode` 递归渲染树，顶部胶囊入口对应原生标题栏的「N 个子智能体 / N 个后台任务」 |
| `src/client/board/register.ts` | `registerTab` 接线 + tab 图标 |
| `src/client/index.ts` | `apply()` 第一行调用 `registerBoardTab(ctx)` |

## 验证

```bash
pnpm typecheck
pnpm test        # tests/board-model.test.ts 模型、tests/board-register.test.ts 接线、
                 # tests/board-render.test.ts 用 react-dom/server 把组件渲一遍
pnpm build       # 产物是 lib/client.js
```

改动后要把 `lib/client.js` 复制到 `~/.dsh/profiles/desktop/node_modules/dsh-maestro-codex/lib/`，并刷新 dsh 页面（客户端插件包只在 `pnpm run dev:web` 同时运行时才热更新）。
