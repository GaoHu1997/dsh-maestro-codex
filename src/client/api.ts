/**
 * Browser-side fetch client for the plugin's host routes. Plain fetch against
 * same-origin paths; every failure resolves to `{ ok: false, error }` so
 * callers can branch without try/catch.
 */

import {
  ROUTE_CLI_INSTALL, ROUTE_CLI_REFRESH, ROUTE_CLI_UNINSTALL, ROUTE_CLI_VERSIONS, ROUTE_HINT, ROUTE_MODELS, ROUTE_OVERVIEW,
  ROUTE_TASK_CANCEL, ROUTE_TASK_DETAIL, ROUTE_TASKS,
  type DshProviderModels, type MaestroCliId, type MaestroCliVersions, type MaestroMcpServerRef, type MaestroOverview, type MaestroTaskDetail, type MaestroTaskRef, type MaestroTaskSummary,
} from '../wire.js'

/** One route call outcome: the parsed body, or the error envelope. */
export type Call<T> = (T & { ok: true }) | { ok: false; error: string }

async function send<T>(method: string, url: string, body?: unknown): Promise<Call<T>> {
  try {
    const response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { ok: false, error: `HTTP ${String(response.status)}` }
    }
    if (!response.ok) {
      const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
      return { ok: false, error: typeof record['error'] === 'string' ? record['error'] : `HTTP ${String(response.status)}` }
    }
    return { ...(payload as T), ok: true }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

export async function fetchOverview(): Promise<Call<MaestroOverview>> {
  return send<MaestroOverview>('GET', ROUTE_OVERVIEW)
}

export async function fetchTasks(sessionIds?: readonly string[]): Promise<Call<{ tasks: MaestroTaskSummary[] }>> {
  const scope = sessionQuery(sessionIds)
  return send<{ tasks: MaestroTaskSummary[] }>('GET', scope === '' ? ROUTE_TASKS : `${ROUTE_TASKS}?sessions=${scope}`)
}

export async function fetchTaskDetail(id: string, after: number, sessionIds?: readonly string[]): Promise<Call<MaestroTaskDetail>> {
  const scope = sessionQuery(sessionIds)
  return send<MaestroTaskDetail>('GET', `${ROUTE_TASK_DETAIL}?id=${encodeURIComponent(id)}&cursor=${String(after)}${scope === '' ? '' : `&sessions=${scope}`}`)
}

export async function cancelTask(id: string, sessionIds?: readonly string[]): Promise<Call<MaestroTaskRef>> {
  return send<MaestroTaskRef>('POST', ROUTE_TASK_CANCEL, sessionIds === undefined || sessionIds.length === 0 ? { id } : { id, sessions: [...sessionIds] })
}

/** The board's session-tree scope, encoded for a query string ('' = unscoped). */
function sessionQuery(sessionIds: readonly string[] | undefined): string {
  return sessionIds === undefined || sessionIds.length === 0 ? '' : encodeURIComponent(sessionIds.join(','))
}

export async function refreshCli(cli?: MaestroCliId): Promise<Call<{ clis: MaestroOverview['clis'] }>> {
  return send<{ clis: MaestroOverview['clis'] }>('POST', ROUTE_CLI_REFRESH, cli === undefined ? {} : { cli })
}

/** Versions published for one CLI's npm package (SDK card picker). */
export async function fetchCliVersions(cli: MaestroCliId): Promise<Call<MaestroCliVersions>> {
  return send<MaestroCliVersions>('GET', `${ROUTE_CLI_VERSIONS}?cli=${encodeURIComponent(cli)}`)
}

export async function installCli(cli: MaestroCliId, version?: string): Promise<Call<MaestroTaskRef>> {
  return send<MaestroTaskRef>('POST', ROUTE_CLI_INSTALL, version === undefined ? { cli } : { cli, version })
}

export async function uninstallCli(cli: MaestroCliId): Promise<Call<MaestroTaskRef>> {
  return send<MaestroTaskRef>('POST', ROUTE_CLI_UNINSTALL, { cli })
}

export async function fetchHint(): Promise<Call<{ hint: string }>> {
  return send<{ hint: string }>('GET', ROUTE_HINT)
}

export async function fetchModels(): Promise<Call<{ providers: DshProviderModels[]; mcpServers?: MaestroMcpServerRef[] }>> {
  return send<{ providers: DshProviderModels[]; mcpServers?: MaestroMcpServerRef[] }>('GET', ROUTE_MODELS)
}
