/**
 * Browser-side fetch client for the plugin's host routes. Plain fetch against
 * same-origin paths; every failure resolves to `{ ok: false, error }` so
 * callers can branch without try/catch.
 */

import {
  ROUTE_CLI_INSTALL, ROUTE_CLI_REFRESH, ROUTE_CLI_UNINSTALL, ROUTE_DISPATCH, ROUTE_HINT, ROUTE_OVERVIEW,
  ROUTE_TASK_CANCEL, ROUTE_TASK_DETAIL, ROUTE_TASKS,
  type MaestroCliId, type MaestroOverview, type MaestroTaskDetail, type MaestroTaskRef, type MaestroTaskSummary,
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

export async function fetchTasks(): Promise<Call<{ tasks: MaestroTaskSummary[] }>> {
  return send<{ tasks: MaestroTaskSummary[] }>('GET', ROUTE_TASKS)
}

export async function fetchTaskDetail(id: string, after: number): Promise<Call<MaestroTaskDetail>> {
  return send<MaestroTaskDetail>('GET', `${ROUTE_TASK_DETAIL}?id=${encodeURIComponent(id)}&cursor=${String(after)}`)
}

export async function cancelTask(id: string): Promise<Call<MaestroTaskRef>> {
  return send<MaestroTaskRef>('POST', ROUTE_TASK_CANCEL, { id })
}

export async function dispatchManual(input: { cli: string; task: string; cwd?: string; model?: string; timeout_minutes?: number }): Promise<Call<MaestroTaskRef>> {
  return send<MaestroTaskRef>('POST', ROUTE_DISPATCH, input)
}

export async function refreshCli(cli?: MaestroCliId): Promise<Call<{ clis: MaestroOverview['clis'] }>> {
  return send<{ clis: MaestroOverview['clis'] }>('POST', ROUTE_CLI_REFRESH, cli === undefined ? {} : { cli })
}

export async function installCli(cli: MaestroCliId): Promise<Call<MaestroTaskRef>> {
  return send<MaestroTaskRef>('POST', ROUTE_CLI_INSTALL, { cli })
}

export async function uninstallCli(cli: MaestroCliId): Promise<Call<MaestroTaskRef>> {
  return send<MaestroTaskRef>('POST', ROUTE_CLI_UNINSTALL, { cli })
}

export async function fetchHint(): Promise<Call<{ hint: string }>> {
  return send<{ hint: string }>('GET', ROUTE_HINT)
}
