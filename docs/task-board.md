# 任务看板（右侧栏 tab）

一个 tab 里同时看三类「正在进行的事」：DSH 会话树（主任务 + 各级子代理）、CLI 子代理（`dispatch_cli_task` 派发）、DSH 后台任务（jobs）。前两者**折成一棵树**——会话树是骨架，CLI 子代理按「归属会话」挂成它的子节点；后台任务**不进树**，单独画在底部的固定高度列表里（占面板总高度的 1/5）。

## 座位

不是 DSH 内核的右侧栏 tab，而是第三方插件 `dsh-better-sidebar` 的扩展点：它在 `client/index.tsx` 里 `ctx.provide('betterSidebar', service)`，我们对它 `ctx.inject(['betterSidebar'], …)` 再 `registerTab({ id: 'maestro-board', title: '任务看板', order: 45, single: true, component })`。

- `betterSidebar` 是**可选**服务：没装那个插件时注入回调永远不触发，看板不存在，其余功能不受影响；所以它不在插件的 `inject` 声明里（那会让整个客户端 half 加载失败）。
- `single: true` = 全局一个实例（多点几次不会开第二个）。
- 重复 `registerTab` 会抛错（热重载两次 `apply` 时可能遇到），`register.ts` 捕获后只打一条 `console.warn`。

## 数据从哪来

| 区块 | 数据源 | 备注 |
| --- | --- | --- |
| DSH 会话树 | `ctx.sessions.list` 的 `byId[scope.sessionId]`（根）+ `byId[*].parentId` + `projectionsBySession[*].values.subagentCatalog` | 两边取并集：目录只记直系，血缘补充漏网的子级 |
| CLI 任务 | 本插件的 `GET /plugin/dsh-maestro-codex/tasks?sessions=<id,…>`、`.../task-detail?id&cursor&sessions=…`、`POST .../task-cancel`（body `{id, sessions}`） | 2.5s 轮询列表、900ms 轮询展开项日志；`sessions` 传当前会话树的 id 集合 |
| 后台任务 | `ctx.jobs`（`state.getSnapshot/subscribe`、`watchRows`、`observe`、`kill`） | 按树上的会话 id 逐个 `watchRows`，客户端去重合并 |

全部是**客户端已有 feed**，不新增 host 路由，也不改 `src/wire.ts` 的契约。

## 一棵树：`attachRows`

`model.ts` 的 `buildSessionTree` 只产出**骨架**（`kind: 'agent'` 的会话节点）。`attachRows(root, { tasks })` 再把 CLI 任务挂上去：

- 节点 id 带前缀，避免和会话 id 撞：CLI 节点是 `cli:<taskId>`（`CLI_NODE_PREFIX`）。
- 挂载点就是「归属会话」：CLI 任务用 `MaestroTaskSummary.sessionId`（`dispatch_cli_task` 派发时写的是 `exec.agent.id`）。没有归属（`sessionId` 为空）的 CLI 任务挂到根。
- 挂载点不在树上 → **丢弃**（树外的会话不属于这个 tab 的视野）。
- 同一层的顺序：血缘子级 → CLI 任务。没挂任何东西的分支**保持原对象引用**（`useMemo` 才不会每轮全量重建）。
- `collectTreeIds` 只收 `kind === 'agent'` 的 id。混进 `cli:` 前缀的 id 会让 CLI 任务的 `sessions` 过滤查错会话。

## 底部后台任务面板

后台任务**单独显示**在树下方的一块固定高度列表里（`flex-basis: 20%`，正好占面板总高度的 1/5，内部滚动）——树只讲「会话 + CLI 子代理」的层级故事，作业一行一个平铺，不再混进树的层级里：

- 数据还是 `useBoardJobs` 的 `BoardJobRow[]`，用 `model.ts` 的 `jobNode()` 折成同一套 `BoardNode` 模型——状态点、图标、元信息、详情浮层全部复用。
- 行尾直接给「终止」（还在跑的作业），点行开同一个「节点详情」浮层（看保留输出、跳所属会话）。
- 面板跟着顶部筛选走（「失败」只列失败的作业）；被筛掉时头部计数显示 `N / M`。
- 作业树外归属的过滤在 `collectJobRows`（data 层）：按 `job.owner` 判断，无主作业任何名册都可见。
- 宿主没有 `jobs` 服务时**整块面板不渲染**，树占满剩余高度。

## 两种视图

同一个树结构，两套画法，底栏切换（默认「图」）：

- **图**（`GraphView` + `collectBands`）：按层级折成「带」——第一层是根，第二层是它的子级，依此类推；每带一行、卡片横排居中，带与带之间画一条竖线、每张卡上方一小段引线。这是 `dsh-better-sidebar` Tasks 页那种「父在上、子横排」的观感。**不做**绝对定位的力导向布局：面板只有两三百像素宽，斜线会把节点压成一团。
- **树**（`TreeNode`）：缩进列表，`.dmb-kids` 用 `margin-left` + 左边框画层级线，行尾三角收子树。

收起的节点不再往下展开（`collectBands` / `TreeNode` 都读同一个 `folded` 集合）。点卡片/行开「节点详情」浮层，浮层贴着被点的那个节点（`DetailAnchor`：`left` 夹在面板内，下方空间不够就翻到节点上方），浮层里是状态、模式、Token 用量、耗时，加动作按钮（打开会话 / 查看转录 / 取消 / 终止）。底部面板里的作业行开的是同一个浮层。

## 折叠已结束的兄弟

一层里节点一多（一次跑十几个子代理），已完成的会淹没还在跑的那几个。`model.ts` 的 `foldFinished(node, { minMembers })` 把**同一层里已结束的兄弟**收成一个 `kind: 'fold'` 节点：

- 标题是「已完成 N」，`members` 存着被收起来的原节点，`children` 默认空（收起）。
- chip 里点名：`members.slice(0, 2)` 的标题用 ` / ` 连起来，超过两个补 ` +N`。**这条是硬要求**——CLI 子代理必须始终在树里可见，折叠不能把它们彻底藏掉。
- 少于 `minMembers`（默认 2）个已结束兄弟就不收：只剩一个时收起来反而多点一次。
- **失败的不收**：出错要一眼看见。
- 收与不收看的是整棵子树（`quiet(node)` = 自己结束且所有子孙也都结束）。一个会话可能自己已结束、底下还挂着在跑的子代理或 CLI 任务，收起来会把活的东西藏了。
- 展开是另一趟：`expandFolds(node, expanded)` 按 `expanded` 集合把 `members` 塞回 `children`。分组只算一次，点开不重算全树。
- 统计走折叠**之前**的树（`allRows`），折叠组的成员不该从计数里消失。

## 用量对账

CLI 子代理的 token 与请求记录不在 dsh 的 token 账本里（那本账只记 dsh 自己发出的模型调用），所以插件在 `src/usage.ts` 里补一条独立的记录面：

- 每次 `runDispatch` 结束，`reportCliUsage` 向**所属会话**（`exec.agent.session`）追加 `maestro/cli-usage` 事件，payload 是该次调用的 `CliUsageRecord`（CLI、模型、阶段、退出码、起止时间、四类 token）。
- 插件同时向 `ctx.sessionProjections` 注册 `maestroCliUsage` projection（`stateVersion: 1`），把事件累加成 `{ totals, recent }`（最近 20 条）。
- dsh 与其他插件读 `projectionsBySession[sessionId].values.maestroCliUsage`；插件自身也可以 `ctx.sessionProjections.stateOf(session, 'maestroCliUsage')` 直读。
- 之所以不用 `assistant/message` / `assistant/attempt`：前者会进对话 surface，后者会被 dsh 的 `addReplacing` 当成同一 turn/step 的样本**替换**主模型用量，且会让客户端 turn-tail 的 attempt 聚合状态机变成 invalid。自定义事件两条路都不碰，宿主升级也不会冲突。

## 降级

- 没有 `sessions` 服务 → 树退化成「当前会话」一个节点，其余照常。
- 没有 `jobs` 服务 → 底部后台任务面板整个不出现（不占那 1/5 高度），树照常；计数与筛选只算树上的行。
- `subagentCatalog` 里 `mode: 'external'` 的行（CLI 子代理没有本地 Session）画成**幽灵节点**（斜体），因为它点进去没有会话可开；真正派发的 CLI 任务有 `cli:` 节点，带实时阶段与转录。
- 树节点默认全展开；折叠只收子树，点节点开详情（详情里「打开会话」走 `ctx.get('workspace').openSession`，退化到 `sessions.open`）。
- 血缘数据理论上可能有环，`buildSessionTree` 用 `visiting` 祖先链剪枝，重复 id 不会再展开。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/client/board/model.ts` | 纯函数：建骨架树、挂 CLI 任务（`attachRows`）、后台作业节点（`jobNode`，给底部面板用）、折叠已结束兄弟（`foldFinished`/`expandFolds`）、摊平、按筛选剪枝（`filterTree`）、状态映射、格式化。**不 import React**，单测直接跑 |
| `src/client/board/data.ts` | hooks：会话 feed、作业名册 + 观察、CLI 列表/详情轮询、每秒 tick |
| `src/client/board/Board.tsx` | 组件 + CSS（token 走 `--dsh-*`，注入一份 `<style>`，幂等）；`GraphView`/`GraphCard` 画图视图，`TreeNode` 画缩进树，`JobsPanel` 画底部后台任务列表（`flex-basis: 20%`），`NodeDetail` 是浮层 |
| `src/client/board/register.ts` | `registerTab` 接线 + tab 图标 |
| `src/client/index.ts` | `apply()` 第一行调用 `registerBoardTab(ctx)` |

## 验证

```bash
pnpm typecheck
pnpm test        # tests/board-model.test.ts 模型（含 attachRows、foldFinished/expandFolds）、
                 # tests/board-register.test.ts 接线、
                 # tests/board-render.test.ts 用 react-dom/server 把组件渲一遍（含 collectBands、折叠行）
pnpm build       # 产物是 lib/client.js
```

> 本机 `pnpm install` / `pnpm typecheck` 会因 `ERR_PNPM_IGNORED_BUILDS ... esbuild` 直接失败，改用二进制：
> `./node_modules/.bin/tsc -p tsconfig.json --noEmit`、`./node_modules/.bin/tsc -p tsconfig.client.json --noEmit`、
> `./node_modules/.bin/vitest run`、`./node_modules/.bin/tsdown`。

改动后要把 `lib/client.js` 复制到 `~/.dsh/profiles/desktop/node_modules/dsh-maestro-codex/lib/`，并刷新 dsh 页面（客户端插件包只在 `pnpm run dev:web` 同时运行时才热更新）。

### 本地视觉检查

`.tmp/visual/` 有一个不发货的 harness：`board.tsx` 用假宿主（sessions 投影 + jobs 名册 + mock 掉 `/tasks`、`/task` 路由）挂 `BoardTab`，`tsdown.board.ts` 打成 IIFE：

```bash
./node_modules/.bin/tsdown -c .tmp/visual/tsdown.board.ts
# 然后用浏览器打开 .tmp/visual/board-light.html
# #view=tree 切缩进视图，#node=<id> 打开详情，#log=1 展开转录
```

比在 dsh 里试快得多：不用重启宿主、不用等真实任务。
