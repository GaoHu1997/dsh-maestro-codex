/** Narrow adapter for the original task window's two existing sidebar routes. */
import type { SidebarTeamTaskView } from '../context-types.ts'

export interface TeamsTaskCreateRequest {
  subject: string
  description: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
}
export interface TeamsTaskUpdateRequest {
  taskId: string
  expectedRevision: number
  action: 'claim' | 'release' | 'edit' | 'set_dependencies' | 'complete' | 'reopen' | 'reassign' | 'delete'
  subject?: string
  description?: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
  owner?: string
}
export type TeamsTaskMutationResult =
  | { ok: true; value: SidebarTeamTaskView }
  | { ok: false; code?: string; message: string }

/** Same-origin page base, not Electron's cross-origin stream transport. */
export function teamTaskUrl(method: 'teams.taskCreate' | 'teams.taskUpdate', baseUrl: string): URL {
  const base = new URL(baseUrl)
  base.search = ''
  base.hash = ''
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(`sidebar/api/${method}`, base)
}
async function writeTask(method: 'teams.taskCreate' | 'teams.taskUpdate', payload: Record<string, unknown>): Promise<TeamsTaskMutationResult> {
  if (typeof document === 'undefined') return { ok: false, code: 'unavailable', message: 'Task API requires the host page.' }
  try {
    const response = await fetch(teamTaskUrl(method, document.baseURI).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const parsed: { ok?: boolean; value?: SidebarTeamTaskView; error?: { code?: string; message?: string } } | null = await response.json().catch(() => null)
    if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
      return { ok: false, code: parsed?.error?.code ?? 'http', message: parsed?.error?.message ?? `HTTP ${response.status}` }
    }
    return { ok: true, value: parsed.value }
  } catch (error) {
    return { ok: false, code: 'network', message: error instanceof Error ? error.message : String(error) }
  }
}
export const api = {
  teamsTaskCreate: (rootSessionId: string, req: TeamsTaskCreateRequest) => writeTask('teams.taskCreate', { rootSessionId, ...req }),
  teamsTaskUpdate: (rootSessionId: string, req: TeamsTaskUpdateRequest) => writeTask('teams.taskUpdate', { rootSessionId, ...req }),
}
