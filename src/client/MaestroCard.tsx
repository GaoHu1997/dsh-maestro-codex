/**
 * The plugin configuration card on the dsh Plugins settings page: the routing
 * table, per-CLI permission/model configuration, CLI lifecycle management
 * (install / update / uninstall / refresh), the task monitor with cancel, and
 * a manual dispatch form that doubles as the smoke-test entry. Plain React +
 * inline styles — the web shell has no CSS pipeline and the card must be
 * self-contained in the plugin bundle.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { cancelTask, dispatchManual, fetchModels, fetchOverview, fetchTaskDetail, installCli, refreshCli, uninstallCli, type Call } from './api.js'
import { fieldText, type MaestroFormActions, type MaestroFormState, type MaestroStore, type StagedField } from './form.js'
import { CLI_LABELS, MAESTRO_CLI_IDS, type DshProviderModels, type MaestroCliId, type MaestroOverview, type MaestroPhase, type MaestroTaskDetail, type MaestroTaskSummary } from '../wire.js'

/** The props the slot entry injects (see client/index.ts). */
export interface MaestroCardProps {
  maestroStore: MaestroStore
  maestro: MaestroFormActions
}

const S = {
  card: { display: 'flex', flexDirection: 'column' as const, gap: 18, fontSize: 13, color: 'var(--dsh-text-primary, #e6e8eb)' },
  section: { border: '1px solid var(--dsh-border, rgba(255,255,255,0.1))', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  sectionTitle: { fontSize: 13, fontWeight: 600, opacity: 0.9, margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  label: { minWidth: 130, opacity: 0.75 },
  input: { flex: 1, minWidth: 200, background: 'var(--dsh-bg-input, rgba(255,255,255,0.06))', border: '1px solid var(--dsh-border, rgba(255,255,255,0.12))', borderRadius: 6, padding: '5px 8px', color: 'inherit', fontSize: 13 },
  select: { background: 'var(--dsh-bg-input, rgba(255,255,255,0.06))', border: '1px solid var(--dsh-border, rgba(255,255,255,0.12))', borderRadius: 6, padding: '5px 8px', color: 'inherit', fontSize: 13 },
  textarea: { width: '100%', minHeight: 56, resize: 'vertical' as const, background: 'var(--dsh-bg-input, rgba(255,255,255,0.06))', border: '1px solid var(--dsh-border, rgba(255,255,255,0.12))', borderRadius: 6, padding: '5px 8px', color: 'inherit', fontSize: 12, fontFamily: 'inherit' },
  button: { background: 'var(--dsh-bg-hover, rgba(255,255,255,0.1))', border: '1px solid var(--dsh-border, rgba(255,255,255,0.12))', borderRadius: 6, padding: '4px 10px', color: 'inherit', fontSize: 12, cursor: 'pointer' },
  primary: { background: '#2563eb', borderColor: '#2563eb', color: '#fff' },
  danger: { color: '#f87171' },
  hint: { fontSize: 11, opacity: 0.6, lineHeight: 1.5 },
  statusDot: (installed: boolean) => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: installed ? '#34d399' : '#9ca3af', marginRight: 6 }),
  code: { fontSize: 11, opacity: 0.7, fontFamily: 'monospace' },
  phase: (phase: MaestroPhase) => ({ fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid var(--dsh-border, rgba(255,255,255,0.12))',
    color: phase === 'done' ? '#34d399' : phase === 'failed' ? '#f87171' : phase === 'running' ? '#60a5fa' : phase === 'timeout' ? '#fbbf24' : 'inherit' }),
  events: { maxHeight: 220, overflow: 'auto' as const, background: 'var(--dsh-bg-input, rgba(0,0,0,0.25))', borderRadius: 6, padding: 8, fontSize: 11, lineHeight: 1.6, fontFamily: 'monospace', whiteSpace: 'pre-wrap' as const },
}

const PHASE_LABELS: Record<MaestroPhase, string> = {
  queued: '排队中', running: '执行中', done: '已完成', failed: '失败', cancelled: '已取消', timeout: '超时',
}

function useStore<T>(store: { getSnapshot(): T; subscribe(listener: () => void): () => void }): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** One text row with a staged draft. */
function TextRow(props: { label: string; field: StagedField; state: MaestroFormState; actions: MaestroFormActions; placeholder?: string; password?: boolean; hint?: string }): ReactNode {
  return (
    <div style={S.row}>
      <span style={S.label}>{props.label}</span>
      <input
        style={S.input}
        type={props.password === true ? 'password' : 'text'}
        value={fieldText(props.state, props.field)}
        placeholder={props.placeholder}
        onChange={event => { props.actions.editStaged(props.field, event.target.value) }}
      />
      {props.hint === undefined ? undefined : <span style={S.hint}>{props.hint}</span>}
    </div>
  )
}

/** One select row (write-through). */
function SelectRow(props: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; hint?: string }): ReactNode {
  return (
    <div style={S.row}>
      <span style={S.label}>{props.label}</span>
      <select style={S.select} value={props.value} onChange={event => { props.onChange(event.target.value) }}>
        {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {props.hint === undefined ? undefined : <span style={S.hint}>{props.hint}</span>}
    </div>
  )
}

/** One switch row (write-through). */
function SwitchRow(props: { label: string; checked: boolean; onChange: (value: boolean) => void; hint?: string }): ReactNode {
  return (
    <div style={S.row}>
      <label style={{ ...S.row, cursor: 'pointer' }}>
        <input type="checkbox" checked={props.checked} onChange={event => { props.onChange(event.target.checked) }} />
        <span>{props.label}</span>
      </label>
      {props.hint === undefined ? undefined : <span style={S.hint}>{props.hint}</span>}
    </div>
  )
}

const CLI_OPTIONS = MAESTRO_CLI_IDS.map(cli => ({ value: cli, label: CLI_LABELS[cli] }))

/** The dsh-model select: `<provider>::<model>` options grouped by provider, filtered by CLI protocol. */
function DshModelSelect(props: { cli: MaestroCliId; value: string; providers: DshProviderModels[] | undefined; onChange: (value: string) => void }): ReactNode {
  const usableApi = props.cli === 'claude' ? 'anthropic-messages' : 'openai-responses'
  const providers = props.providers ?? []
  const mappable = providers.filter(provider => provider.mappable && (usableApi === undefined || provider.api === usableApi))
  const unusableCount = providers.filter(provider => provider.mappable && !(usableApi === undefined || provider.api === usableApi)).length
  return (
    <div style={S.row}>
      <span style={S.label}>dsh 模型</span>
      <select
        style={S.select}
        value={props.value}
        onChange={event => { props.onChange(event.target.value) }}
      >
        <option value="">不使用（CLI 自身配置的模型）</option>
        {mappable.map(provider => (
          <optgroup key={provider.id} label={`${provider.displayName}（${provider.api}${provider.models.length === 0 ? '' : ` · ${String(provider.models.length)} 个模型`}）`}>
            {provider.models.map(model => (
              <option key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{model}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <span style={S.hint}>
        {props.cli === 'claude' ? '仅列出 Anthropic 兼容（anthropic-messages）供应商' : '仅列出 openai-responses 协议供应商（codex 0.146+ 已移除 chat 支持）'}
        {unusableCount > 0 ? `；另有 ${String(unusableCount)} 个协议不匹配的供应商未列出` : ''}
        {providers !== undefined && mappable.length === 0 ? '；当前 dsh 没有可映射的供应商' : ''}
      </span>
    </div>
  )
}

export function MaestroCard(props: MaestroCardProps): ReactNode {
  const form = useStore(props.maestroStore)
  const actions = props.maestro
  const [overview, setOverview] = useState<MaestroOverview | undefined>(undefined)
  const [overviewError, setOverviewError] = useState('')
  const [dshProviders, setDshProviders] = useState<DshProviderModels[] | undefined>(undefined)
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<MaestroTaskDetail | undefined>(undefined)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  // Manual dispatch form state.
  const [dispatchCli, setDispatchCli] = useState('auto')
  const [dispatchTask, setDispatchTask] = useState('')
  const [dispatchCwd, setDispatchCwd] = useState('')

  const values = form.values

  const pollOverview = useCallback(async (): Promise<void> => {
    const result = await fetchOverview()
    if (result.ok) {
      const { ok: _ok, ...rest } = result
      setOverview(rest as MaestroOverview)
      setOverviewError('')
    } else {
      setOverviewError(result.error)
    }
  }, [])

  useEffect(() => {
    void pollOverview()
    const timer = setInterval(() => { void pollOverview() }, 4000)
    return () => { clearInterval(timer) }
  }, [pollOverview])

  // The dsh model catalog: loaded once per card mount (the pickers' options).
  useEffect(() => {
    let disposed = false
    void fetchModels().then(result => {
      if (disposed) return
      if (result.ok) {
        const { ok: _ok, ...rest } = result
        setDshProviders(rest.providers)
      }
    })
    return () => { disposed = true }
  }, [])

  // Poll the selected task's detail while it is interesting.
  useEffect(() => {
    if (selectedId === '') {
      setDetail(undefined)
      return
    }
    let disposed = false
    let cursor = 0
    const tick = async (): Promise<void> => {
      const result = await fetchTaskDetail(selectedId, cursor)
      if (disposed || !result.ok) return
      const { ok: _ok, ...rest } = result
      cursor = rest.nextCursor
      setDetail(previous => previous === undefined || previous.summary.phase !== rest.summary.phase || previous.summary === rest.summary
        ? rest
        : { ...rest, events: [...previous.events, ...rest.events].slice(-400) })
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 2000)
    return () => { disposed = true; clearInterval(timer) }
  }, [selectedId])

  const withBusy = async (label: string, run: () => Promise<Call<unknown>>): Promise<void> => {
    setBusy(label)
    setNotice('')
    const result = await run()
    setBusy('')
    if (result.ok) {
      if ('id' in result && typeof result.id === 'string') setSelectedId(result.id)
      void pollOverview()
    } else {
      setNotice(result.error)
    }
  }

  return (
    <div style={S.card}>
      <div style={S.section}>
        <SwitchRow
          label="启用 CLI 子代理"
          checked={values.enabled === true}
          onChange={value => { actions.setImmediate('enabled', value) }}
          hint="关闭后主会话不再注册 dispatch 工具，配置页仍可管理 CLI"
        />
        <SelectRow
          label="默认 CLI"
          value={String(values.defaultCli ?? 'claude')}
          options={CLI_OPTIONS}
          onChange={value => { actions.setImmediate('defaultCli', value) }}
          hint="无任务类型命中时使用"
        />
        {form.invalid !== undefined && <div style={{ ...S.hint, color: '#fbbf24' }}>{form.invalid.message}</div>}
        <div style={S.row}>
          <button
            style={{ ...S.button, ...(form.dirty.length > 0 ? S.primary : {}) }}
            disabled={!form.writable || form.saving || form.dirty.length === 0}
            onClick={() => { void actions.save() }}
          >{form.saving ? '保存中…' : `保存修改${form.dirty.length > 0 ? `（${form.dirty.length}）` : ''}`}</button>
          <button style={S.button} disabled={form.dirty.length === 0} onClick={() => { actions.discard() }}>放弃</button>
          {form.failed && <span style={{ ...S.hint, color: '#f87171' }}>上次保存未生效，请重试</span>}
          {form.dirty.length > 0 && <span style={S.hint}>改动（模型/路径/任务类型等）需保存后生效；开关与下拉即时生效</span>}
        </div>
      </div>

      <div style={S.section}>
        <p style={S.sectionTitle}>claude cli</p>
        <SwitchRow label="启用" checked={values.claudeEnabled === true} onChange={value => { actions.setImmediate('claudeEnabled', value) }} />
        <div style={S.row}>
          <span style={S.label}>任务类型</span>
          <textarea
            style={S.textarea}
            value={fieldText(form, 'claudeTaskTypes')}
            placeholder={'每行一个关键词，如：\n重构\n测试\n文档'}
            onChange={event => { actions.editStaged('claudeTaskTypes', event.target.value) }}
          />
        </div>
        <TextRow label="模型" field="claudeModel" state={form} actions={actions} placeholder="留空用 CLI 默认，如 claude-sonnet-4-5" />
        <DshModelSelect
          cli="claude"
          value={String(values.claudeDshModel ?? '')}
          providers={dshProviders}
          onChange={value => { actions.setImmediate('claudeDshModel', value) }}
        />
        <SelectRow
          label="权限"
          value={String(values.claudePermissionMode ?? 'inherit')}
          options={[
            { value: 'inherit', label: '继承（CLI 非交互默认策略）' },
            { value: 'default', label: 'default（保守）' },
            { value: 'acceptEdits', label: 'acceptEdits（自动接受文件编辑）' },
            { value: 'plan', label: 'plan（只读规划）' },
            { value: 'bypassPermissions', label: 'bypassPermissions（跳过所有确认）' },
          ]}
          onChange={value => { actions.setImmediate('claudePermissionMode', value) }}
          hint="headless 无法交互确认，写入类任务建议 acceptEdits 及以上"
        />
        <TextRow label="API 地址" field="claudeBaseUrl" state={form} actions={actions} placeholder="可选，ANTHROPIC_BASE_URL（复用 dsh 配置的兼容端点）" />
        <TextRow label="Auth Token" field="claudeAuthToken" state={form} actions={actions} placeholder="可选，ANTHROPIC_AUTH_TOKEN" password />
        <TextRow label="CLI 路径" field="claudeCliPath" state={form} actions={actions} placeholder="可选，claude 可执行文件完整路径" />
        <TextRow label="超时（分钟）" field="claudeTimeoutMinutes" state={form} actions={actions} placeholder="20" />
      </div>

      <div style={S.section}>
        <p style={S.sectionTitle}>codex cli</p>
        <SwitchRow label="启用" checked={values.codexEnabled === true} onChange={value => { actions.setImmediate('codexEnabled', value) }} />
        <div style={S.row}>
          <span style={S.label}>任务类型</span>
          <textarea
            style={S.textarea}
            value={fieldText(form, 'codexTaskTypes')}
            placeholder={'每行一个关键词，如：\n脚本\n快速修复'}
            onChange={event => { actions.editStaged('codexTaskTypes', event.target.value) }}
          />
        </div>
        <TextRow label="模型" field="codexModel" state={form} actions={actions} placeholder="留空用 CLI 默认，如 gpt-5-codex" />
        <DshModelSelect
          cli="codex"
          value={String(values.codexDshModel ?? '')}
          providers={dshProviders}
          onChange={value => { actions.setImmediate('codexDshModel', value) }}
        />
        <SelectRow
          label="沙箱/权限"
          value={String(values.codexSandbox ?? 'workspace-write')}
          options={[
            { value: 'read-only', label: 'read-only（只读）' },
            { value: 'workspace-write', label: 'workspace-write（可写工作区，full-auto）' },
            { value: 'danger-full-access', label: 'danger-full-access（无沙箱）' },
          ]}
          onChange={value => { actions.setImmediate('codexSandbox', value) }}
          hint="codex exec 非交互，沙箱即权限边界"
        />
        <TextRow label="API 地址" field="codexBaseUrl" state={form} actions={actions} placeholder="可选，OPENAI_BASE_URL（OpenAI 兼容端点）" />
        <TextRow label="API Key" field="codexApiKey" state={form} actions={actions} placeholder="可选，OPENAI_API_KEY" password />
        <TextRow label="CLI 路径" field="codexCliPath" state={form} actions={actions} placeholder="可选，codex 可执行文件完整路径" />
        <div style={S.row}>
          <span style={S.label}>-c 覆盖项</span>
          <textarea
            style={S.textarea}
            value={fieldText(form, 'codexConfigOverrides')}
            placeholder={'每行一个 codex -c 覆盖，如：\nmodel_instructions_file="C:\\path\\AGENTS.md"'}
            onChange={event => { actions.editStaged('codexConfigOverrides', event.target.value) }}
          />
        </div>
        <TextRow label="超时（分钟）" field="codexTimeoutMinutes" state={form} actions={actions} placeholder="20" />
      </div>

      <div style={S.section}>
        <p style={S.sectionTitle}>CLI 管理</p>
        <TextRow label="npm registry" field="npmRegistry" state={form} actions={actions} placeholder="可选，如 https://registry.npmmirror.com" />
        <TextRow label="并发上限" field="maxConcurrentTasks" state={form} actions={actions} placeholder="2" hint="同时运行的 CLI 任务数（1–8）" />
        {MAESTRO_CLI_IDS.map(cli => {
          const status = overview?.clis?.[cli]
          return (
            <div key={cli} style={{ ...S.row, borderTop: '1px dashed var(--dsh-border, rgba(255,255,255,0.08))', paddingTop: 8 }}>
              <span><span style={S.statusDot(status?.installed === true)} />{CLI_LABELS[cli]}</span>
              <span style={S.code}>{status === undefined ? '…' : status.installed ? `${status.version} · ${status.path}` : (status.error ?? '未安装')}</span>
              <span style={{ flex: 1 }} />
              <button style={S.button} disabled={busy !== ''} onClick={() => { void withBusy(`refresh-${cli}`, () => refreshCli(cli)) }}>刷新</button>
              <button
                style={S.button}
                disabled={busy !== ''}
                onClick={() => { void withBusy(`install-${cli}`, () => installCli(cli)) }}
              >{status?.installed === true ? '更新' : '安装'}</button>
              <button
                style={{ ...S.button, ...S.danger }}
                disabled={busy !== '' || status?.installed !== true}
                onClick={() => {
                  if (globalThis.confirm(`确认卸载 ${CLI_LABELS[cli]}？（npm -g uninstall）`)) void withBusy(`uninstall-${cli}`, () => uninstallCli(cli))
                }}
              >卸载</button>
            </div>
          )
        })}
        <div style={S.hint}>安装/更新/卸载通过 npm -g 执行，过程可在下方任务区实时查看。</div>
      </div>

      <div style={S.section}>
        <p style={S.sectionTitle}>任务监视</p>
        <div style={S.row}>
          <select style={S.select} value={dispatchCli} onChange={event => { setDispatchCli(event.target.value) }}>
            <option value="auto">自动路由</option>
            {CLI_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <input style={{ ...S.input, flex: 0.6 }} placeholder="执行目录（可选，绝对路径）" value={dispatchCwd} onChange={event => { setDispatchCwd(event.target.value) }} />
          <button
            style={{ ...S.button, ...S.primary }}
            disabled={busy !== '' || dispatchTask.trim() === ''}
            onClick={() => {
              void withBusy('dispatch', () => dispatchManual({
                cli: dispatchCli,
                task: dispatchTask,
                ...(dispatchCwd.trim() === '' ? {} : { cwd: dispatchCwd.trim() }),
              })).then(() => { setDispatchTask('') })
            }}
          >派发任务</button>
        </div>
        <textarea style={{ ...S.textarea, minHeight: 48 }} placeholder="手动派发一个任务做冒烟测试（等同主会话调用 dispatch 工具）" value={dispatchTask} onChange={event => { setDispatchTask(event.target.value) }} />
        {overviewError !== '' && <div style={{ ...S.hint, color: '#f87171' }}>无法连接宿主路由：{overviewError}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(overview?.tasks ?? []).map(task => (
            <div
              key={task.id}
              style={{ ...S.row, cursor: 'pointer', background: task.id === selectedId ? 'var(--dsh-bg-hover, rgba(255,255,255,0.08))' : 'transparent', borderRadius: 6, padding: '3px 6px' }}
              onClick={() => { setSelectedId(task.id === selectedId ? '' : task.id) }}
            >
              <span style={S.phase(task.phase)}>{PHASE_LABELS[task.phase]}</span>
              <span style={S.code}>{task.cli}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{task.title}</span>
              {task.phase === 'running' || task.phase === 'queued'
                ? <button
                    style={{ ...S.button, ...S.danger }}
                    onClick={event => {
                      event.stopPropagation()
                      void withBusy(`cancel-${task.id}`, () => cancelTask(task.id))
                    }}
                  >取消</button>
                : undefined}
            </div>
          ))}
          {(overview?.tasks ?? []).length === 0 && <div style={S.hint}>暂无任务记录</div>}
        </div>
        {detail !== undefined && (
          <div style={S.events}>{detail.events.map(event => {
            const time = new Date(event.at).toLocaleTimeString()
            return <div key={event.seq}>{`[${time}] ${event.kind === 'error' ? '✗ ' : ''}${event.text}`}</div>
          })}
          {detail.finalText !== undefined && <div style={{ marginTop: 6, borderTop: '1px dashed rgba(255,255,255,0.2)', paddingTop: 6 }}>{detail.finalText}</div>}
          {detail.error !== undefined && <div style={{ color: '#f87171' }}>{detail.error}</div>}
          </div>
        )}
      </div>

      {notice !== '' && <div style={{ ...S.hint, color: '#f87171' }}>{notice}</div>}
    </div>
  )
}
