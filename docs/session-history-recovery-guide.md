# 历史会话与账务恢复（安装用户）

升级代码只修复以后创建的记录，不会自动改写已经落盘的会话事件或旧账务。CLI 记录镜像是 one-shot 查看记录，不能交给普通 DSH 执行器继续回复；续接请使用原 CLI 的 Maestro 入口，并保持相同可信父会话归属。

## 先区分故障

- **任务仍可查看但用量缺失**：未知值不等于零。对照当前版本的宿主能力报告和健康面，保留 canonical 用量账本，不把父会话投影与标准子记录镜像重复相加。
- **CLI 任务在宿主中断后显示 interrupted**：这表示上次进程没有完成，不会自动重跑可能改文件的任务。由人确认是否重新派发。
- **历史会话无法重放，日志指出未知事件或不支持的子记录模式**：代码更新未必能纠正旧日志，需要版本匹配、受控的离线迁移；不要关闭宿主 schema 校验、删除聊天事件或把失败记录改成成功。

## 安全恢复顺序

1. 记录实际 DSH、Maestro 与相关统计插件版本，以及脱敏后的错误和受影响会话 ID。不要在公开问题中上传 API token、完整凭据或含敏感任务正文的原始日志。
2. 先完整备份受影响的会话目录及 `$DSH_HOME/maestro` 下相关任务、用量账本和副作用记录。只针对确认的会话，不批量扫描或修改其他用户目录。
3. 如需要改写严格日志，由用户安排维护窗口、停止对应宿主写入，再取得适用于当前版本的迁移方案。审核 dry-run 的准确文件集合、事件类型与预期变化后才允许写入；每个被改文件必须保留可回滚备份。
4. 在副本上验证完整历史重放、父子归属与本轮/累计用量。不删真实聊天事件，不伪造零消耗，不把私有父投影和标准子记录镜像相加。核验通过后再由用户决定是否应用到原始记录。
5. 任何无法识别的版本、事件或权限能力应停止迁移并报告，不以放宽授权或禁用校验换取“恢复成功”。

## 已知旧 CLI 日志的严格迁移

当前安装包附带 [CLI 生命周期迁移工具](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/scripts/repair-cli-session-logs.mjs) 及其 codec/runtime 依赖。它不是自动启动迁移：默认只做 dry-run，只有显式 `--apply` 与审核过的原文件 SHA-256 才会写入。

它只修复已确认的四事件旧镜像：`request/context → maestro/cli-child → step/start → assistant/attempt` 缺少 turn/step 结束边界。修复只添加 `turn/start`、`step/end`、`turn/end` 并重排 `seq`；保持原 header、时间、扩展元数据与累计 usage，不把旧 attempt 改成成功，不重放 canonical 账本。

```sh
# 将参数替换为实际安装路径和已审核的单个日志；不要批量照抄现场路径。
node scripts/repair-cli-session-logs.mjs --dsh-root /absolute/path/to/dsh /absolute/path/to/session.v4.jsonl.zstd
node scripts/repair-cli-session-logs.mjs --dsh-root /absolute/path/to/dsh --apply --expect-sha256 ORIGINAL_SHA256 /absolute/path/to/session.v4.jsonl.zstd
```

- 必须使用支持 Zstandard 的 Node 与真实 DSH runtime。完整 v4 校验使用宿主 catalog，不通过关闭校验掩盖错误。
- 写入当前只支持已经验证的 persistence `0.2.1-rc.5` 与 `0.2.2-rc.1` / v4（两版写租约协议一致，后者仅新增锁定后 inode 复核）；未知版本或无法取得同宿主 writer lease 时拒绝写入。Windows 使用与 DSH 相同的 named semaphore，POSIX 使用相同 flock 协议（本轮只实测 Windows）。
- 每份原日志保留逐字节、带 SHA-256 的 `.maestro-cli-original-<hash>.bak`；验证、fsync、身份复核后通过新 inode 原子替换。重跑合法日志是 no-op。源文件变化、陌生形态、损坏帧或路径异常均停止该文件，不删除用户数据。
- 任意损坏日志不是本工具的通用修复范围。维护窗口、版本审核、精确文件集合与迁移后账目核验仍然必需。

[历史现场记录](https://github.com/GaoHu1997/dsh-maestro-codex/blob/master/docs/session-history-recovery.md) 是历史证据，不是可照抄的通用安装说明。其他故障请通过 [项目问题页](https://github.com/GaoHu1997/dsh-maestro-codex/issues) 获取适用于实际版本的方案。

日常只读观察见 [可靠性面](<reliability.md>)；任务、续接与统计的边界见 [任务看板说明](<task-board.md>)。状态脚本不执行会话迁移，也不修改宿主数据。
