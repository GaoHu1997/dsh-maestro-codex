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

describe('upstream source fidelity', () => {
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
      'AnchoredPopover.tsx', 'TasksPopovers.tsx',
      'JobsDrawer.tsx', 'FloatingWindow.tsx', 'FloatingWindow.module.css',
    ]) expect(manifest.files.find(entry => entry.path === `client/${file}`)?.mode, file).toBe('verbatim')
  })

  it('allows only the isolated CLI executor badge additions to the original renderer', () => {
    const additions: Record<string, string[]> = {
      'TasksGraph.tsx': ["        {...(node.executor === undefined ? {} : { executor: node.executor })}\n"],
      'TasksTree.tsx': ["                {node.executor !== undefined && node.executor !== '' && (\n                  <span className={css.kindBadge} data-cli-executor={node.executor}\n                    title={`CLI · ${node.executor}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>\n                    {node.executor}\n                  </span>\n                )}\n"],
      'tasks-card.tsx': ["  /** CLI executor badge, on the right of the existing identity row. */\n  executor?: string\n", "        {props.executor !== undefined && props.executor !== '' && (\n          <span className={css.kindBadge} data-cli-executor={props.executor}\n            title={`CLI · ${props.executor}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>\n            {props.executor}\n          </span>\n        )}\n"],
      'tasks-model.ts': ["  /** Maestro CLI executor identity; absent on native agents. */\n  executor?: string\n"],
    }
    for (const [file, snippets] of Object.entries(additions)) {
      const entry = manifest.files.find(row => row.path === `client/${file}`)
      expect(entry?.mode).toBe('adapted-cli-badge')
      let source = readFileSync(new URL(`client/${file}`, root), 'utf8')
      for (const snippet of snippets) {
        expect(source.split(snippet)).toHaveLength(2)
        source = source.replace(snippet, '')
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
