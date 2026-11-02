# 方案：CLI 子代理「查看会话」在主窗口打开

> **已实施并回退（2026-10-31）**：主窗口视图当天完整落地后，用户决定**所有子代理会话只在侧边打开**——CLI 的 `conversation.view` 视图（`workspace-view.tsx` / `session-request.ts`）、CLI 浮层的分体按钮、dsh 节点浮层的「在主窗口中打开」caret、以及 `jumpBoardNode` 的主窗口导航兜底全部移除。dsh 侧的移除是通过 vendored 浮层的一次有意偏离完成的（`upstream/source-manifest.json` 中 `TasksPopovers.tsx` 记为 `adapted-side-only-jump`，`upstream-source.test.ts` 断言主窗口痕迹不存在）。本文保留**宿主源码层面的调研结论**——它们解释了为什么这条路能做但没必要，未来若要重开不必重新考古。

## 1. 宿主能力面（源码核对结论，`D:\devlop\Deepseek Harness Desktop\resources\dsh\node_modules\@deepseek-ai\`）

| 服务 | 能力 | 对主窗口需求 |
| --- | --- | --- |
| `dsh-client-ui-workspace` `UiWorkspace` | 只有会话导航：`openSession(SessionTarget)`、`openWorkspace`、`forkSession`…；`SessionTarget = SessionId \| SubagentAddress` | ❌ CLI 没有本地 DSH 会话，无法导航 |
| `dsh-client-ui-conversation` `main.conversation` 槽 | `single`，被会话壳自己占用 | ❌ 不可共存 |
| **`conversation.view` 槽** | 视图 tab 注册表：`slots.entries('conversation.view')` 投影成会话头部的 tab 栏；激活的视图渲染进主区 `viewArea`。`dsh-client-ui-trajectory` 就这样注册了 trajectory 视图 | ✅ 可行（实施过又移除） |
| 视图偏好写入（`setView`/`openView`） | 只在会话壳 `conversation.session` 槽的 inject 闭包里，没有跨插件 API；per-session 持久化 store（`dsh.conversation.<sessionId>`）对已挂载会话不回读 localStorage；`binding.activate()` 只激活数据目标不切 UI | ❌ 程序化激活只能靠点击宿主 tab 的 DOM 锚点（`[data-conversation-tabs] button[role="tab"]`，宿主自己的 `selectView` 路径） |

## 2. 曾落地的形态（已移除，留档）

- 客户端 apply 注册 `{id: 'maestro-cli-session', label: 'CLI 会话'}` 视图，组件读模块级共享请求渲染 `SessionPage place="view"`（撑满 viewArea、自管滚动；退回按钮调视图区 render props 的 `openView('chat')`）。
- 看板 CLI 浮层分体按钮：主按钮面板内会话页，caret「在主窗口中打开」写请求 + 点击宿主 tab 激活，失败回落面板。
- dsh 节点浮层：上游本有「side 主按钮 + main caret」分体。

**回退原因**：用户裁定子代理会话不该把主窗口从当前对话上引开，看板只负责侧边。

## 3. 现行状态（side-only）

- **CLI**：浮层单一「查看会话」按钮，面板内覆盖层（`Session.tsx` 恢复 panel 单档）。
- **dsh 子代理**：浮层跳转按钮只在宿主有 `subagentchat` 右栏座位时出现，点击固定走 `sidebarRight.openResource('dsh-resource://subagentchat/…')`；根节点（主会话）与无侧栏座位时不再渲染跳转按钮。
- **工作流成员行**：同一条侧边通道（`jumpBoardAddress`）。
- **bridge**：`jumpBoardNode(ctx, node)` 只剩侧边一路，`uiWorkspace`/`workspace`/`sessions` 导航代码已删。

## 4. 若未来要重开

按 §1 的结论：注册 `conversation.view`（公开、一等）+ 激活走 `[data-conversation-tabs]` DOM 点击（唯一可行的程序化激活）+ 无侧栏/改版回落。工作量约一天（含测试）。
