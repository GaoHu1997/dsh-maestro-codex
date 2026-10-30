/** Explicit compatible task-note adapter, not the original explorer integration.
 * Markdown rendering/copy chrome remains host-owned. File links are inert unless
 * the caller supplies Context.openMarkdownFile; no endpoint is inferred.
 */
import { useCallback, useRef } from 'react'
import type { Context } from '../context-types.ts'
export interface MarkdownSurfaceOptions { ctx: Context; sessionId: string; cwd?: string; path?: string }
export interface MarkdownSurfaceBinding {
  surfaceRef: (element: HTMLElement | null) => void
  openFile: (destination: string, options?: { line?: number }) => void
  rewrite: (text: string) => string
}
export function useMarkdownSurface(opts: MarkdownSurfaceOptions): MarkdownSurfaceBinding {
  const surface = useRef<HTMLElement | null>(null)
  const surfaceRef = useCallback((element: HTMLElement | null): void => {
    surface.current = element
    element?.setAttribute('data-dsh-md-surface', '')
  }, [])
  const openFile = useCallback((destination: string, options?: { line?: number }): void => {
    if (destination.startsWith('#')) {
      const target = Array.from(surface.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(element => element.id === destination.slice(1))
      target?.scrollIntoView({ block: 'start' })
      return
    }
    // Only local Markdown belongs to this adapter. URLs and other file types
    // retain the host renderer's handling outside this explicit delegate.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(destination) || !/\.md(?:#.*)?$/i.test(destination)) return
    opts.ctx.openMarkdownFile?.(opts.sessionId, destination, options)
  }, [opts.ctx, opts.sessionId])
  const rewrite = useCallback((text: string): string => text, [])
  return { surfaceRef, openFile, rewrite }
}
