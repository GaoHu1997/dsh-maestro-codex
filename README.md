# dsh-maestro-codex

[![npm](https://img.shields.io/npm/v/dsh-maestro-codex?logo=npm)](https://www.npmjs.com/package/dsh-maestro-codex)
[![release](https://github.com/GaoHu1997/dsh-maestro-codex/actions/workflows/release.yml/badge.svg)](https://github.com/GaoHu1997/dsh-maestro-codex/actions/workflows/release.yml)
[![license](https://img.shields.io/npm/l/dsh-maestro-codex)](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/LICENSE)

dsh 的 CLI 子代理编排插件：把会话中的任务按类型派发给 **codex cli** 或 **claude cli**（headless）执行，取回结果回填主会话。

## 能力

- **dispatch 工具**：在主会话注册 `dispatch_cli_task` 工具，dsh 主代理按路由表自主判断任务类型并派发，取回 CLI 的最终结果继续对话。
- **路由表**：配置页为每个 CLI 配置任务类型关键词（如"重构/测试/文档 → claude，脚本/快速修复 → codex"）与默认 CLI。
- **权限配置**：claude 支持 `default / acceptEdits / plan / bypassPermissions`（`继承` = 使用 CLI 非交互默认策略）；codex 通过沙箱（`read-only / workspace-write / danger-full-access`）划界。
- **模型配置（dsh 目录直选）**：配置页的「dsh 模型」下拉直接列出 dsh 中已配置的供应商与模型（读取 llm-pi-ai 设置 + credentials 密钥）。选中后插件自动把端点/密钥/模型注入 CLI——codex 经 `-c` 合成 model_provider（仅 openai-responses 协议，codex 0.146+ 已移除 chat 支持），claude 经 ANTHROPIC_BASE_URL/AUTH_TOKEN（仅 anthropic-messages 协议）。也可留空用手动填写的 API 地址与 Token。
- **CLI 管理**：配置页检测版本、一键安装/更新/卸载（npm -g：`@anthropic-ai/claude-code`、`@openai/codex`），支持自定义 registry 与 CLI 路径。
- **任务监视**：进度事件流（工具调用/命令/文本增量）、取消、超时（每 CLI 可配）、并发上限。

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
