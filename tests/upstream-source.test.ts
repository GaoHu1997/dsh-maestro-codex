import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../src/client/board/upstream/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('source-manifest.json', root), 'utf8')) as {
  repository: string; version: string
  files: { path: string; mode: string; sha256: string; sourceSha256?: string }[]
  dependencies: { entry: string; sha256: string; version: string }[]
}
const sha256 = (file: string) => createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex')
const originalRendererHashes: Readonly<Record<string, string>> = {
  'TasksGraph.tsx': '8bf7cea9e36eb76c7ff1c54f684cef2dd02b570abd0c157754777c5b851b652c',
  'TasksTree.tsx': '71ea4c8950aa4303ca1779c6b75a102cc1005da4c1b3c199a20a5397225d2271',
  'tasks-card.tsx': '017391388ab9b083c01341ef21adfff6786fc77de9e2955ba3578c66c153917f',
  'tasks-model.ts': '2dce027e42e3bfb5ba74c308a8ec953846180b4ba83dadb7c68e01b5f563a453',
}

describe('upstream source fidelity', () => {
  it('pins the unmodified 0.28.2 renderer baselines independently of the manifest', () => {
    for (const [file, original] of Object.entries(originalRendererHashes)) {
      expect(manifest.files.find(entry => entry.path === `client/${file}`)?.sourceSha256, file).toBe(original)
    }
  })

  it('retains the release identity and every imported source hash', () => {
    expect(manifest.repository).toBe('https://github.com/omdsh-dev/DSH-better-sidebar')
    expect(manifest.version).toBe('0.28.2')
    for (const entry of manifest.files) expect(sha256(entry.path), entry.path).toBe(entry.sha256)
  })

  it('keeps renderer, card, layout, animation and CSS sources verbatim', () => {
    for (const file of [
      'tasks-graph-layout.ts',
      'tasks-layout-tween.ts', 'tasks-view-glide.ts', 'frame-batcher.ts',
      'tasks-graph.module.css', 'tasks-canvas.module.css', 'tasks-shared.tsx',
      'AnchoredPopover.tsx',
      'JobsDrawer.tsx', 'FloatingWindow.tsx', 'FloatingWindow.module.css',
    ]) expect(manifest.files.find(entry => entry.path === `client/${file}`)?.mode, file).toBe('verbatim')
  })

  it('keeps the popover transcript jump side-only (upstream main-window caret removed)', () => {
    const entry = manifest.files.find(row => row.path === 'client/TasksPopovers.tsx')
    expect(entry?.mode).toBe('adapted-side-only-jump')
    const source = readFileSync(new URL('client/TasksPopovers.tsx', root), 'utf8')
    // 主窗口跳转的全部痕迹都不在：caret、菜单面、宿主词条与打开兜底。
    for (const absent of ['tasksNodeOpenMain', 'MenuSurface', 'useDismissOnOutsidePointer', "'main'", 'jumpMore', 'jumpMenu']) {
      expect(source.includes(absent), `TasksPopovers must not reference ${absent}`).toBe(false)
    }
    // 侧边跳转语义仍在：primary 按钮只发 'side'，宿主没有 subagentchat 时收起。
    expect(source).toContain("onJump(node, 'side')")
    expect(source).toContain('asideAvailable && node.childAddress !== undefined')
    // sourceSha256 记录它偏离的上游原版（0.28.2 verbatim）。
    expect(entry?.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('allows only the isolated CLI badge and interrupted-state adaptations to the original renderer', () => {
    // 每条 = 纯插入（字符串，还原为删除），或替换对 [新增文本, 上游原文]。
    type Addition = string | [added: string, original: string]
    const additions: Record<string, Addition[]> = {
      'TasksGraph.tsx': [['aria-label={`${node.label} ${node.stateText ?? agentMeta(node)}`}', 'aria-label={`${node.label} ${agentMeta(node)}`}'], "        {...(node.executor === undefined ? {} : { executor: node.executor })}\n", "        {...(node.stateText === undefined ? {} : { stateText: node.stateText })}\n"],
      'TasksTree.tsx': [['aria-label={`${node.label} ${node.stateText ?? agentMeta(node)}`}', 'aria-label={`${node.label} ${agentMeta(node)}`}'], "                {node.executor !== undefined && node.executor !== '' && (\n                  <span className={css.kindBadge} data-cli-executor={node.executor}\n                    title={`CLI · ${node.executor}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>\n                    {node.executor}\n                  </span>\n                )}\n", ['{node.stateText ?? (chip === undefined ? agentMeta(node) : stateLabel(node.state))}', '{chip === undefined ? agentMeta(node) : stateLabel(node.state)}']],
      'tasks-card.tsx': ["  /** CLI executor badge, on the right of the existing identity row. */\n  executor?: string\n", "        {props.executor !== undefined && props.executor !== '' && (\n          <span className={css.kindBadge} data-cli-executor={props.executor}\n            title={`CLI · ${props.executor}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>\n            {props.executor}\n          </span>\n        )}\n", "  /** CLI-only wording that keeps the state slot for a state the native four cannot name. */\n  stateText?: string\n", ['{props.stateText ?? stateLabel(state)}', '{stateLabel(state)}']],
      'tasks-model.ts': ["  /** CLI-only display states applied before fold derivation; absent for native agents. */\n  cliStates?: ReadonlyMap<string, TasksNodeState>\n", ["const state: TasksNodeState = input.cliStates?.get(entry.id) ?? (activity === 'running'\n        ? 'running'\n        : team !== undefined ? teamState(team.status) : 'done')", "const state: TasksNodeState = activity === 'running'\n        ? 'running'\n        : team !== undefined ? teamState(team.status) : 'done'"], "  /** Maestro CLI executor identity; absent on native agents. */\n  executor?: string\n", "  /** CLI-only state word (interrupted tasks keep a state slot the native four cannot name). */\n  stateText?: string\n"],
    }
    for (const [file, snippets] of Object.entries(additions)) {
      const entry = manifest.files.find(row => row.path === `client/${file}`)
      expect(entry?.mode).toBe('adapted-cli-badge-and-interrupted-state')
      let source = readFileSync(new URL(`client/${file}`, root), 'utf8')
      for (const snippet of snippets) {
        const [added, original] = typeof snippet === 'string' ? [snippet, ''] : snippet
        expect(source.split(added)).toHaveLength(2)
        source = source.replace(added, original)
      }
      expect(createHash('sha256').update(source).digest('hex'), file).toBe(entry?.sourceSha256)
    }
  })

  it('retains original library code and all MIT notices', () => {
    for (const dependency of manifest.dependencies) expect(sha256(dependency.entry), dependency.entry).toBe(dependency.sha256)
    expect(manifest.dependencies.map(entry => entry.version)).toEqual(['2.1.1', '0.10.0'])
    expect(readFileSync(new URL('LICENSE', root), 'utf8')).toContain('Copyright (c) 2026 dsh-external')
    expect(readFileSync(new URL('../THIRD_PARTY_NOTICES', import.meta.url), 'utf8')).toContain('omdsh-dev')
  })
})
