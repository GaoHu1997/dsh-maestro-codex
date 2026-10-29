/**
 * The plugin configuration card on the dsh settings page — "CLI 配置".
 *
 * Tabbed layout, one concern per tab: per-CLI configuration (CLI 管理 — one
 * expandable row per CLI with model / task-type / permission / connection
 * settings and a test-run form), CLI binary management (SDK 管理 — npm
 * install / update / uninstall per package), routing defaults (调度设置) and
 * the task monitor with the manual dispatch smoke-test entry (任务监视).
 *
 * Plain React + one injected stylesheet: the web shell has no CSS pipeline
 * and the card must be self-contained in the plugin bundle. The stylesheet
 * carries its own design tokens — host `--dsh-*` variables win when defined,
 * otherwise `light-dark()` adapts to the surrounding theme, so text keeps a
 * readable contrast on both light and dark shells.
 */

import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import {
  cancelTask, dispatchManual, fetchHint, fetchModels, fetchOverview, fetchTaskDetail,
  installCli, refreshCli, uninstallCli, type Call,
} from './api.js'
import { fieldText, type MaestroFormActions, type MaestroFormState, type MaestroStore, type StagedField } from './form.js'
import {
  CLI_LABELS, CLI_PACKAGES, MAESTRO_CLI_IDS,
  type DshProviderModels, type MaestroCliId, type MaestroOverview, type MaestroPhase,
  type MaestroTaskDetail,
} from '../wire.js'

/** The props the slot entry injects (see client/index.ts). */
export interface MaestroCardProps {
  maestroStore: MaestroStore
  maestro: MaestroFormActions
  /** Workspace paths for the dispatch form's cwd auto-fill. */
  workspaces?: string[] | undefined
}

/** Per-CLI identity colors, reused by the row monograms and the task list. */
const CLI_BRAND: Record<MaestroCliId, string> = { claude: '#d97757', codex: '#10a37f' }
const CLI_MONOGRAM: Record<MaestroCliId, string> = { claude: 'CL', codex: 'CX' }

const CLI_OPTIONS = MAESTRO_CLI_IDS.map(cli => ({ value: cli, label: CLI_LABELS[cli] }))

const PHASE_LABELS: Record<MaestroPhase, string> = {
  queued: '排队中', running: '执行中', done: '已完成', failed: '失败', cancelled: '已取消', timeout: '超时',
}

/** The phase dot's color; running pulses. */
const PHASE_COLOR: Record<MaestroPhase, string> = {
  queued: 'var(--dmc-fg3)', running: 'var(--dmc-accent)', done: 'var(--dmc-ok)',
  failed: 'var(--dmc-danger)', cancelled: 'var(--dmc-fg3)', timeout: 'var(--dmc-warn)',
}

type TabId = 'cli' | 'sdk' | 'routing' | 'tasks'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'cli', label: 'CLI 管理' },
  { id: 'sdk', label: 'SDK 管理' },
  { id: 'routing', label: '调度设置' },
  { id: 'tasks', label: '任务监视' },
]

/**
 * The card stylesheet. Design tokens first: host variables (`--dsh-*`) win;
 * the `light-dark()` fallbacks keep every surface readable in either theme
 * (the old card washed text with opacity, which was unreadable on light
 * shells). `color-scheme` also fixes native selects/scrollbars per theme.
 */
const CARD_CSS = `
.dmc {
  --dmc-fg: var(--dsh-text-primary, light-dark(#1a1e26, #e9ebf0));
  --dmc-fg2: var(--dsh-text-secondary, light-dark(#3f4756, #b7bfcc));
  --dmc-fg3: var(--dsh-text-tertiary, light-dark(#646d80, #8e97a8));
  --dmc-accent: var(--dsh-accent, light-dark(#2f5fe0, #7292ff));
  --dmc-accent-soft: color-mix(in srgb, var(--dmc-accent) 11%, transparent);
  --dmc-panel: var(--dsh-bg-secondary, light-dark(#f7f8fa, #20242e));
  --dmc-input: var(--dsh-bg-input, light-dark(#ffffff, #262b37));
  --dmc-border: var(--dsh-border, light-dark(#dce0e8, #2e3440));
  --dmc-hover: var(--dsh-bg-hover, light-dark(#edeff4, #2a3040));
  --dmc-ok: light-dark(#0e8a55, #3ddc97);
  --dmc-warn: light-dark(#b45309, #fbbf24);
  --dmc-danger: light-dark(#d92d20, #ff7b72);
  /* No color-scheme here on purpose: the card inherits the scheme the host
   * page picked (or the OS preference when it picks none), and light-dark()
   * resolves against that — the card follows the shell it is embedded in. */
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 880px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dmc-fg);
}
.dmc, .dmc *, .dmc *::before, .dmc *::after { box-sizing: border-box; }

/* --- header --- */
.dmc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dmc-title { margin: 0; font-size: 16px; font-weight: 650; }
.dmc-subtitle { margin: 2px 0 0; font-size: 12px; color: var(--dmc-fg3); }
.dmc-headside { display: flex; align-items: center; gap: 10px; flex: none; padding-top: 2px; }

/* --- chips --- */
.dmc-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 1px 9px; border-radius: 999px; white-space: nowrap; }
.dmc-chip-ok { color: var(--dmc-ok); background: color-mix(in srgb, var(--dmc-ok) 12%, transparent); }
.dmc-chip-warn { color: var(--dmc-warn); background: color-mix(in srgb, var(--dmc-warn) 13%, transparent); }
.dmc-chip-err { color: var(--dmc-danger); background: color-mix(in srgb, var(--dmc-danger) 11%, transparent); }
.dmc-chip-idle { color: var(--dmc-fg3); background: color-mix(in srgb, var(--dmc-fg3) 13%, transparent); }
.dmc-chip-accent { color: var(--dmc-accent); background: var(--dmc-accent-soft); }
.dmc-chips { display: flex; flex-wrap: wrap; gap: 6px; }

/* --- tabs --- */
.dmc-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dmc-border); flex-wrap: wrap; }
.dmc-tab { appearance: none; background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 7px 12px; font-size: 13px; font-weight: 550; color: var(--dmc-fg3); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: color .15s; }
.dmc-tab:hover { color: var(--dmc-fg); }
.dmc-tab-active, .dmc-tab-active:hover { color: var(--dmc-accent); border-bottom-color: var(--dmc-accent); }
.dmc-badge { min-width: 16px; height: 16px; padding: 0 5px; border-radius: 999px; background: var(--dmc-accent); color: #fff; font-size: 10.5px; font-weight: 650; display: inline-flex; align-items: center; justify-content: center; }
.dmc-tab:focus-visible, .dmc-btn:focus-visible { outline: 2px solid var(--dmc-accent); outline-offset: 2px; border-radius: 6px; }
.dmc-rowbtn:focus-visible { outline: 2px solid var(--dmc-accent); outline-offset: -2px; }

/* --- rows --- */
.dmc-row { border: 1px solid var(--dmc-border); border-radius: 12px; background: var(--dmc-panel); overflow: hidden; }
.dmc-stack { display: flex; flex-direction: column; gap: 10px; }
.dmc-rowbtn { display: flex; align-items: center; gap: 12px; width: 100%; padding: 11px 14px; background: none; border: none; color: inherit; cursor: pointer; text-align: left; transition: background .15s; }
.dmc-rowbtn:hover { background: var(--dmc-hover); }
.dmc-rowmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dmc-rowname { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.dmc-rowsub { font-size: 11.5px; color: var(--dmc-fg3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmc-mono { width: 30px; height: 30px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; letter-spacing: .03em; flex: none; }
.dmc-chevron { flex: none; color: var(--dmc-fg3); transition: transform .18s; }
.dmc-chevron-open { transform: rotate(180deg); }
.dmc-detail { border-top: 1px solid var(--dmc-border); }
.dmc-body { padding: 14px; display: flex; flex-direction: column; gap: 14px; }

/* --- groups & fields --- */
.dmc-group { display: flex; flex-direction: column; gap: 10px; }
.dmc-grouptitle { margin: 0; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; color: var(--dmc-fg3); }
.dmc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 16px; }
.dmc-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dmc-fieldwide { grid-column: 1 / -1; }
.dmc-label { font-size: 12px; font-weight: 550; color: var(--dmc-fg2); display: flex; align-items: center; gap: 6px; }
.dmc-dirty { width: 6px; height: 6px; border-radius: 999px; background: var(--dmc-warn); flex: none; }
.dmc-hint { font-size: 11px; color: var(--dmc-fg3); line-height: 1.5; }

/* --- inputs --- */
.dmc-input, .dmc-select, .dmc-textarea {
  font: inherit; font-size: 13px; color: var(--dmc-fg);
  background: var(--dmc-input); border: 1px solid var(--dmc-border); border-radius: 8px;
  padding: 6px 10px; width: 100%; transition: border-color .15s, box-shadow .15s;
}
.dmc-textarea { min-height: 64px; resize: vertical; font-size: 12.5px; line-height: 1.55; }
.dmc-input:focus, .dmc-select:focus, .dmc-textarea:focus { outline: none; border-color: var(--dmc-accent); box-shadow: 0 0 0 3px var(--dmc-accent-soft); }
.dmc-input::placeholder, .dmc-textarea::placeholder { color: var(--dmc-fg3); opacity: 1; }
.dmc-input:disabled, .dmc-select:disabled, .dmc-textarea:disabled { opacity: .5; cursor: not-allowed; }

/* --- buttons --- */
.dmc-btn { appearance: none; font-size: 12.5px; font-weight: 550; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--dmc-border); background: var(--dmc-input); color: var(--dmc-fg); cursor: pointer; transition: background .15s, border-color .15s, color .15s; white-space: nowrap; }
.dmc-btn:hover:not(:disabled) { background: var(--dmc-hover); }
.dmc-btn:disabled { opacity: .45; cursor: not-allowed; }
.dmc-btn-primary { background: var(--dmc-accent); border-color: var(--dmc-accent); color: #fff; }
.dmc-btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
.dmc-btn-danger { color: var(--dmc-danger); border-color: color-mix(in srgb, var(--dmc-danger) 35%, transparent); background: transparent; }
.dmc-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dmc-danger) 10%, transparent); }
.dmc-btn-sm { padding: 3px 9px; font-size: 11.5px; border-radius: 7px; }

/* --- toggle switch --- */
.dmc-toggle { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.dmc-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.dmc-track { width: 32px; height: 18px; border-radius: 999px; background: color-mix(in srgb, var(--dmc-fg3) 45%, transparent); position: relative; transition: background .18s; flex: none; }
.dmc-toggle input:checked + .dmc-track { background: var(--dmc-accent); }
.dmc-toggle input:focus-visible + .dmc-track { outline: 2px solid var(--dmc-accent); outline-offset: 2px; }
.dmc-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: left .18s; }
.dmc-toggle input:checked + .dmc-track .dmc-knob { left: 16px; }

/* --- save bar --- */
.dmc-savebar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--dmc-warn) 40%, transparent); background: color-mix(in srgb, var(--dmc-warn) 8%, var(--dmc-panel)); box-shadow: 0 -4px 14px rgba(0,0,0,.08); }
.dmc-savebar-text { flex: 1; min-width: 220px; font-size: 12px; color: var(--dmc-fg2); }

/* --- log, code, banners --- */
.dmc-code { font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace; font-size: 11.5px; }
.dmc-log { max-height: 240px; overflow: auto; background: var(--dmc-input); border: 1px solid var(--dmc-border); border-radius: 8px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace; font-size: 11.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; color: var(--dmc-fg2); }
.dmc-log-final { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dmc-border); color: var(--dmc-fg); }
.dmc-banner { padding: 8px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
.dmc-banner-err { color: var(--dmc-danger); background: color-mix(in srgb, var(--dmc-danger) 8%, transparent); border: 1px solid color-mix(in srgb, var(--dmc-danger) 28%, transparent); }

/* --- tasks --- */
.dmc-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dmc-dot { width: 7px; height: 7px; border-radius: 999px; flex: none; display: inline-block; }
.dmc-dot-pulse { animation: dmc-pulse 1.2s ease-in-out infinite; }
@keyframes dmc-pulse { 50% { opacity: .3; } }
.dmc-phase { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--dmc-fg3) 12%, transparent); color: var(--dmc-fg2); }
.dmc-taskrow { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--dmc-border); border-radius: 10px; background: var(--dmc-input); cursor: pointer; transition: background .15s, border-color .15s; min-width: 0; }
.dmc-taskrow:hover { background: var(--dmc-hover); }
.dmc-taskrow-active { border-color: var(--dmc-accent); background: var(--dmc-accent-soft); }
.dmc-tasktitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.dmc-tasktime { flex: none; font-size: 11px; color: var(--dmc-fg3); }
`

const STYLE_ID = 'dsh-maestro-codex-card-styles'

/** Inject the card stylesheet once (id-guarded; several mounts share it). */
function useStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const element = document.createElement('style')
    element.id = STYLE_ID
    element.textContent = CARD_CSS
    document.head.appendChild(element)
  }, [])
}

function useStore<T>(store: { getSnapshot(): T; subscribe(listener: () => void): () => void }): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** A toggle switch (the native checkbox stays in the tree for a11y). */
function Toggle(props: { checked: boolean; onChange: (value: boolean) => void; label?: string | undefined; disabled?: boolean | undefined }): ReactNode {
  return (
    <label className="dmc-toggle">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={event => { props.onChange(event.target.checked) }} />
      <span className="dmc-track"><span className="dmc-knob" /></span>
      {props.label === undefined ? undefined : <span style={{ fontSize: 12.5 }}>{props.label}</span>}
    </label>
  )
}

/** A labeled field block; `dirty` marks a staged draft not saved yet. */
function Field(props: { label: string; dirty?: boolean | undefined; hint?: string | undefined; wide?: boolean | undefined; children: ReactNode }): ReactNode {
  return (
    <div className={props.wide === true ? 'dmc-field dmc-fieldwide' : 'dmc-field'}>
      <span className="dmc-label">
        {props.label}
        {props.dirty === true && <span className="dmc-dirty" title="有未保存的改动" />}
      </span>
      {props.children}
      {props.hint === undefined ? undefined : <span className="dmc-hint">{props.hint}</span>}
    </div>
  )
}

/** One staged text input (commits on save). */
function StagedInput(props: {
  label: string; field: StagedField; state: MaestroFormState; actions: MaestroFormActions
  placeholder?: string | undefined; password?: boolean | undefined; hint?: string | undefined
}): ReactNode {
  return (
    <Field label={props.label} dirty={props.state.dirty.includes(props.field)} hint={props.hint}>
      <input
        className="dmc-input"
        type={props.password === true ? 'password' : 'text'}
        value={fieldText(props.state, props.field)}
        placeholder={props.placeholder}
        onChange={event => { props.actions.editStaged(props.field, event.target.value) }}
      />
    </Field>
  )
}

/** One staged multi-line list editor (one entry per line, commits on save). */
function StagedArea(props: {
  label: string; field: StagedField; state: MaestroFormState; actions: MaestroFormActions
  placeholder?: string | undefined; hint?: string | undefined; children?: ReactNode
}): ReactNode {
  return (
    <Field label={props.label} dirty={props.state.dirty.includes(props.field)} hint={props.hint} wide>
      <textarea
        className="dmc-textarea"
        value={fieldText(props.state, props.field)}
        placeholder={props.placeholder}
        onChange={event => { props.actions.editStaged(props.field, event.target.value) }}
      />
      {props.children}
    </Field>
  )
}

/** One select (writes through immediately). */
function SelectField(props: {
  label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void; hint?: string | undefined
}): ReactNode {
  return (
    <Field label={props.label} hint={props.hint}>
      <select className="dmc-select" value={props.value} onChange={event => { props.onChange(event.target.value) }}>
        {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  )
}

/** Small status pill. */
function StateChip(props: { tone: 'ok' | 'warn' | 'err' | 'idle' | 'accent'; children: ReactNode }): ReactNode {
  return <span className={`dmc-chip dmc-chip-${props.tone}`}>{props.children}</span>
}

/** Expand chevron, rotating when open. */
function Chevron(props: { open: boolean }): ReactNode {
  return (
    <svg className={props.open ? 'dmc-chevron dmc-chevron-open' : 'dmc-chevron'} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The per-CLI identity mark (brand-tinted monogram). */
function Monogram(props: { cli: MaestroCliId }): ReactNode {
  const brand = CLI_BRAND[props.cli]
  const style: CSSProperties = { background: `color-mix(in srgb, ${brand} 16%, transparent)`, color: brand }
  return <span className="dmc-mono" style={style}>{CLI_MONOGRAM[props.cli]}</span>
}

/** Task phase pill with a colored (pulsing when running) dot. */
function PhaseChip(props: { phase: MaestroPhase }): ReactNode {
  return (
    <span className="dmc-phase">
      <span
        className={props.phase === 'running' ? 'dmc-dot dmc-dot-pulse' : 'dmc-dot'}
        style={{ background: PHASE_COLOR[props.phase] }}
      />
      {PHASE_LABELS[props.phase]}
    </span>
  )
}

/** Keyword chips previewing a task-type list. */
function KeywordChips(props: { items: readonly string[] }): ReactNode {
  if (props.items.length === 0) return undefined
  return (
    <div className="dmc-chips">
      {props.items.map(item => <span key={item} className="dmc-chip dmc-chip-accent">{item}</span>)}
    </div>
  )
}

/** The dsh-model select: `<provider>::<model>` options grouped by provider, filtered by CLI protocol. */
function DshModelSelect(props: {
  cli: MaestroCliId; value: string; providers: DshProviderModels[] | undefined; onChange: (value: string) => void
}): ReactNode {
  const usableApi = props.cli === 'claude' ? 'anthropic-messages' : 'openai-responses'
  const providers = props.providers ?? []
  const mappable = providers.filter(provider => provider.mappable && provider.api === usableApi)
  const unusableCount = providers.filter(provider => provider.mappable && provider.api !== usableApi).length
  const hint = [
    props.cli === 'claude' ? '仅列出 Anthropic 兼容（anthropic-messages）供应商' : '仅列出 openai-responses 协议供应商（codex 0.146+ 已移除 chat 支持）',
    unusableCount > 0 ? `；另有 ${String(unusableCount)} 个协议不匹配的供应商未列出` : '',
    providers.length === 0 ? '；当前 dsh 没有可映射的供应商' : '',
  ].join('')
  return (
    <Field label="dsh 模型" hint={hint} wide>
      <select className="dmc-select" value={props.value} onChange={event => { props.onChange(event.target.value) }}>
        <option value="">不使用（CLI 自身配置的模型）</option>
        {mappable.map(provider => (
          <optgroup key={provider.id} label={`${provider.displayName}（${provider.api}${provider.models.length === 0 ? '' : ` · ${String(provider.models.length)} 个模型`}）`}>
            {provider.models.map(model => (
              <option key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{model}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  )
}

/** A cwd field: workspace quick-pick over a free-form absolute path. */
function CwdField(props: { label: string; value: string; workspaces: readonly string[]; onChange: (value: string) => void; hint?: string | undefined }): ReactNode {
  return (
    <Field label={props.label} hint={props.hint}>
      {props.workspaces.length > 0 && (
        <select className="dmc-select" value="" onChange={event => { if (event.target.value !== '') props.onChange(event.target.value) }}>
          <option value="">选择工作区目录…</option>
          {props.workspaces.map(path => <option key={path} value={path}>{path}</option>)}
        </select>
      )}
      <input className="dmc-input" value={props.value} placeholder="留空用插件进程的当前目录" onChange={event => { props.onChange(event.target.value) }} />
    </Field>
  )
}

export function MaestroCard(props: MaestroCardProps): ReactNode {
  useStyles()
  const form = useStore(props.maestroStore)
  const actions = props.maestro
  const values = form.values
  const workspaces = props.workspaces ?? []

  const [tab, setTab] = useState<TabId>('cli')
  const [openCli, setOpenCli] = useState<MaestroCliId | undefined>(undefined)
  const [openSdk, setOpenSdk] = useState<MaestroCliId | undefined>(undefined)

  const [overview, setOverview] = useState<MaestroOverview | undefined>(undefined)
  const [overviewError, setOverviewError] = useState('')
  const [dshProviders, setDshProviders] = useState<DshProviderModels[] | undefined>(undefined)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  // Test-run drafts (tab 1, one per CLI) and the manual dispatch form (tab 4).
  const [testTask, setTestTask] = useState<Partial<Record<MaestroCliId, string>>>({})
  const [testCwd, setTestCwd] = useState('')
  const [dispatchCli, setDispatchCli] = useState('auto')
  const [dispatchTask, setDispatchTask] = useState('')
  const [dispatchCwd, setDispatchCwd] = useState('')

  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<MaestroTaskDetail | undefined>(undefined)
  const [hint, setHint] = useState<{ text: string; error: string }>({ text: '', error: '' })

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
      if (result.ok) setDshProviders(result.providers)
    })
    return () => { disposed = true }
  }, [])

  // The routing hint preview: (re)loaded whenever the routing tab opens.
  useEffect(() => {
    if (tab !== 'routing') return
    let disposed = false
    void fetchHint().then(result => {
      if (disposed) return
      setHint(result.ok ? { text: result.hint, error: '' } : { text: '', error: result.error })
    })
    return () => { disposed = true }
  }, [tab])

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

  /** Run one route call under the global busy flag; errors land in `notice`. */
  async function withBusy<T>(label: string, run: () => Promise<Call<T>>): Promise<Call<T>> {
    setBusy(label)
    setNotice('')
    const result = await run()
    setBusy('')
    if (result.ok) void pollOverview()
    else setNotice(result.error)
    return result
  }

  /** Dispatch a test task for one CLI; on success jump to the task monitor. */
  const runTest = async (cli: MaestroCliId): Promise<void> => {
    const task = (testTask[cli] ?? '').trim()
    if (busy !== '' || task === '') return
    const ref = await withBusy(`test-${cli}`, () => dispatchManual({
      cli,
      task,
      ...(testCwd.trim() === '' ? {} : { cwd: testCwd.trim() }),
    }))
    if (ref.ok) {
      setSelectedId(ref.id)
      setTab('tasks')
      setTestTask(previous => ({ ...previous, [cli]: '' }))
    }
  }

  /** Manual dispatch from the task monitor's smoke-test form. */
  const runDispatch = async (): Promise<void> => {
    const task = dispatchTask.trim()
    if (busy !== '' || task === '') return
    const ref = await withBusy('dispatch', () => dispatchManual({
      cli: dispatchCli,
      task,
      ...(dispatchCwd.trim() === '' ? {} : { cwd: dispatchCwd.trim() }),
    }))
    if (ref.ok) {
      setSelectedId(ref.id)
      setDispatchTask('')
    }
  }

  /** npm install / update / uninstall for one CLI package (confirm on uninstall). */
  const npmAction = (cli: MaestroCliId, action: 'install' | 'uninstall'): void => {
    if (action === 'uninstall' && globalThis.confirm(`确认卸载 ${CLI_PACKAGES[cli]}？（npm -g uninstall）`) === false) return
    void withBusy(`${action}-${cli}`, () => action === 'install' ? installCli(cli) : uninstallCli(cli))
  }

  const refreshAll = (): void => { void withBusy('refresh', () => refreshCli()) }

  const tasks = overview?.tasks ?? []
  const activeCount = tasks.filter(task => task.phase === 'running' || task.phase === 'queued').length

  /** The model summary shown on a collapsed CLI row. */
  const modelSummary = (cli: MaestroCliId): string => {
    const dsh = cli === 'claude' ? values.claudeDshModel : values.codexDshModel
    const own = cli === 'claude' ? values.claudeModel : values.codexModel
    if (typeof dsh === 'string' && dsh !== '') return `dsh 模型 ${dsh}`
    if (typeof own === 'string' && own !== '') return own
    return 'CLI 默认模型'
  }

  const statusOf = (cli: MaestroCliId) => overview?.clis?.[cli]

  /** One expandable CLI row (tab 1): identity, status, and the config panel. */
  const cliRow = (cli: MaestroCliId): ReactNode => {
    const open = openCli === cli
    const status = statusOf(cli)
    const enabled = cli === 'claude' ? values.claudeEnabled === true : values.codexEnabled === true
    const taskTypes = fieldText(form, cli === 'claude' ? 'claudeTaskTypes' : 'codexTaskTypes')
      .split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    const testText = testTask[cli] ?? ''
    return (
      <div key={cli} className="dmc-row">
        <button type="button" className="dmc-rowbtn" aria-expanded={open} onClick={() => { setOpenCli(open ? undefined : cli) }}>
          <Monogram cli={cli} />
          <span className="dmc-rowmain">
            <span className="dmc-rowname">
              {CLI_LABELS[cli]}
              <StateChip tone={status === undefined ? 'idle' : status.installed ? 'ok' : 'warn'}>
                {status === undefined ? '检测中…' : status.installed ? (status.version !== '' ? `v${status.version}` : '已安装') : '未安装'}
              </StateChip>
              {enabled ? undefined : <StateChip tone="idle">已停用</StateChip>}
            </span>
            <span className="dmc-rowsub">
              {`${modelSummary(cli)} · ${String(taskTypes.length)} 类任务`}
            </span>
          </span>
          <Chevron open={open} />
        </button>
        {open && (
          <div className="dmc-detail dmc-body">
            <div className="dmc-field">
              <span className="dmc-label">启用此 CLI</span>
              <Toggle
                checked={enabled}
                label={enabled ? '参与任务路由' : '已停用，不参与路由'}
                onChange={value => { actions.setImmediate(cli === 'claude' ? 'claudeEnabled' : 'codexEnabled', value) }}
              />
            </div>

            <div className="dmc-group">
              <p className="dmc-grouptitle">模型</p>
              <div className="dmc-grid">
                <StagedInput
                  label="CLI 模型"
                  field={cli === 'claude' ? 'claudeModel' : 'codexModel'}
                  state={form}
                  actions={actions}
                  placeholder={cli === 'claude' ? '留空用 CLI 默认，如 claude-sonnet-4-5' : '留空用 CLI 默认，如 gpt-5-codex'}
                />
                <DshModelSelect
                  cli={cli}
                  value={String(cli === 'claude' ? values.claudeDshModel ?? '' : values.codexDshModel ?? '')}
                  providers={dshProviders}
                  onChange={value => { actions.setImmediate(cli === 'claude' ? 'claudeDshModel' : 'codexDshModel', value) }}
                />
              </div>
            </div>

            <StagedArea
              label="任务类型"
              field={cli === 'claude' ? 'claudeTaskTypes' : 'codexTaskTypes'}
              state={form}
              actions={actions}
              placeholder={cli === 'claude' ? '每行一个关键词，如：\n重构\n测试\n文档' : '每行一个关键词，如：\n脚本\n快速修复'}
              hint="任务描述命中关键词时优先派发给该 CLI"
            >
              <KeywordChips items={taskTypes} />
            </StagedArea>

            <div className="dmc-group">
              <p className="dmc-grouptitle">权限与连接</p>
              <div className="dmc-grid">
                {cli === 'claude' ? (
                  <SelectField
                    label="权限模式"
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
                ) : (
                  <SelectField
                    label="沙箱级别"
                    value={String(values.codexSandbox ?? 'workspace-write')}
                    options={[
                      { value: 'read-only', label: 'read-only（只读）' },
                      { value: 'workspace-write', label: 'workspace-write（可写工作区，full-auto）' },
                      { value: 'danger-full-access', label: 'danger-full-access（无沙箱）' },
                    ]}
                    onChange={value => { actions.setImmediate('codexSandbox', value) }}
                    hint="codex exec 非交互，沙箱即权限边界"
                  />
                )}
                <StagedInput
                  label="API 地址"
                  field={cli === 'claude' ? 'claudeBaseUrl' : 'codexBaseUrl'}
                  state={form}
                  actions={actions}
                  placeholder={cli === 'claude' ? '可选，ANTHROPIC_BASE_URL（复用 dsh 兼容端点）' : '可选，OPENAI_BASE_URL（OpenAI 兼容端点）'}
                />
                <StagedInput
                  label={cli === 'claude' ? 'Auth Token' : 'API Key'}
                  field={cli === 'claude' ? 'claudeAuthToken' : 'codexApiKey'}
                  state={form}
                  actions={actions}
                  placeholder={cli === 'claude' ? '可选，ANTHROPIC_AUTH_TOKEN' : '可选，OPENAI_API_KEY'}
                  password
                />
                <StagedInput
                  label="CLI 路径"
                  field={cli === 'claude' ? 'claudeCliPath' : 'codexCliPath'}
                  state={form}
                  actions={actions}
                  placeholder={`可选，${cli} 可执行文件完整路径`}
                />
                <StagedInput
                  label="超时（分钟）"
                  field={cli === 'claude' ? 'claudeTimeoutMinutes' : 'codexTimeoutMinutes'}
                  state={form}
                  actions={actions}
                  placeholder="20"
                  hint="1–240，超时自动终止任务"
                />
                {cli === 'codex' && (
                  <StagedArea
                    label="-c 覆盖项"
                    field="codexConfigOverrides"
                    state={form}
                    actions={actions}
                    placeholder={'每行一个 codex -c 覆盖，如：\nmodel_instructions_file="C:\\path\\AGENTS.md"'}
                  />
                )}
              </div>
            </div>

            <div className="dmc-group">
              <p className="dmc-grouptitle">测试调用</p>
              <Field label="测试任务" hint="以该 CLI 手动派发一次；成功后自动跳到「任务监视」跟踪执行">
                <textarea
                  className="dmc-textarea"
                  style={{ minHeight: 48 }}
                  placeholder={cli === 'claude' ? '例如：阅读 src/routes.ts，整理一份接口清单' : '例如：写一个脚本统计各目录的代码行数'}
                  value={testText}
                  onChange={event => { setTestTask(previous => ({ ...previous, [cli]: event.target.value })) }}
                />
              </Field>
              <CwdField label="执行目录" value={testCwd} workspaces={workspaces} onChange={setTestCwd} hint="可选，绝对路径；选择工作区可快速填入" />
              <div className="dmc-toolbar">
                <button
                  type="button"
                  className="dmc-btn dmc-btn-primary"
                  disabled={busy !== '' || testText.trim() === ''}
                  onClick={() => { void runTest(cli) }}
                >派发测试任务</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  /** One SDK row (tab 2): package identity, install state, npm actions. */
  const sdkRow = (cli: MaestroCliId): ReactNode => {
    const open = openSdk === cli
    const status = statusOf(cli)
    return (
      <div key={cli} className="dmc-row">
        <div
          className="dmc-rowbtn"
          role="button"
          tabIndex={0}
          onClick={() => { setOpenSdk(open ? undefined : cli) }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenSdk(open ? undefined : cli) } }}
        >
          <Monogram cli={cli} />
          <span className="dmc-rowmain">
            <span className="dmc-rowname">
              <span className="dmc-code" style={{ fontSize: 12.5 }}>{CLI_PACKAGES[cli]}</span>
              <StateChip tone={status === undefined ? 'idle' : status.installed ? 'ok' : 'warn'}>
                {status === undefined ? '检测中…' : status.installed ? (status.version !== '' ? `v${status.version}` : '已安装') : '未安装'}
              </StateChip>
            </span>
            <span className="dmc-rowsub">
              {status?.installed === true ? status.path : (status?.error ?? '')}
            </span>
          </span>
          <span className="dmc-toolbar" onClick={event => { event.stopPropagation() }}>
            <button type="button" className="dmc-btn dmc-btn-sm" disabled={busy !== ''} onClick={() => { void withBusy(`refresh-${cli}`, () => refreshCli(cli)) }}>检测</button>
            <button type="button" className="dmc-btn dmc-btn-sm" disabled={busy !== ''} onClick={() => { npmAction(cli, 'install') }}>
              {status?.installed === true ? '更新' : '安装'}
            </button>
            <button
              type="button"
              className="dmc-btn dmc-btn-sm dmc-btn-danger"
              disabled={busy !== '' || status?.installed !== true}
              onClick={() => { npmAction(cli, 'uninstall') }}
            >卸载</button>
          </span>
          <Chevron open={open} />
        </div>
        {open && (
          <div className="dmc-detail dmc-body">
            <div className="dmc-grid">
              <Field label="npm 包"><span className="dmc-code">{CLI_PACKAGES[cli]}</span></Field>
              <Field label="安装路径"><span className="dmc-code">{status?.installed === true ? status.path : '—'}</span></Field>
              {status?.error !== undefined && status.error !== '' && (
                <Field label="检测信息" wide><span className="dmc-hint">{status.error}</span></Field>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="dmc">
      <header className="dmc-head">
        <div>
          <h3 className="dmc-title">CLI 配置</h3>
          <p className="dmc-subtitle">把任务按类型派发给 codex / claude 子代理（headless），取回结果回填主会话</p>
        </div>
        <div className="dmc-headside">
          <StateChip tone={values.enabled === true ? 'ok' : 'idle'}>{values.enabled === true ? '调度开启' : '调度已停用'}</StateChip>
          <Toggle checked={values.enabled === true} onChange={value => { actions.setImmediate('enabled', value) }} />
        </div>
      </header>

      <nav className="dmc-tabs">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'dmc-tab dmc-tab-active' : 'dmc-tab'}
            onClick={() => { setTab(item.id) }}
          >
            {item.label}
            {item.id === 'tasks' && activeCount > 0 && <span className="dmc-badge">{activeCount}</span>}
          </button>
        ))}
      </nav>

      {notice !== '' && <div className="dmc-banner dmc-banner-err">{notice}</div>}

      {tab === 'cli' && <div className="dmc-stack">{MAESTRO_CLI_IDS.map(cliRow)}</div>}

      {tab === 'sdk' && (
        <div className="dmc-stack">
          <div className="dmc-toolbar">
            <Field label="npm registry" dirty={form.dirty.includes('npmRegistry')} hint="可选，镜像源；保存后对后续安装生效">
              <input
                className="dmc-input"
                style={{ minWidth: 240 }}
                value={fieldText(form, 'npmRegistry')}
                placeholder="如 https://registry.npmmirror.com"
                onChange={event => { actions.editStaged('npmRegistry', event.target.value) }}
              />
            </Field>
            <span style={{ flex: 1 }} />
            <button type="button" className="dmc-btn" disabled={busy !== ''} onClick={refreshAll}>全部重新检测</button>
          </div>
          {MAESTRO_CLI_IDS.map(sdkRow)}
          <div className="dmc-hint">安装 / 更新 / 卸载通过 npm -g 执行，过程与结果在「任务监视」标签页实时可见；registry 改动需保存。</div>
        </div>
      )}

      {tab === 'routing' && (
        <div className="dmc-stack">
          <div className="dmc-row">
            <div className="dmc-body">
              <div className="dmc-group">
                <p className="dmc-grouptitle">路由规则</p>
                <div className="dmc-grid">
                  <SelectField
                    label="默认 CLI"
                    value={String(values.defaultCli ?? 'claude')}
                    options={CLI_OPTIONS}
                    onChange={value => { actions.setImmediate('defaultCli', value) }}
                    hint="无任务类型命中时使用"
                  />
                  <StagedInput
                    label="并发上限"
                    field="maxConcurrentTasks"
                    state={form}
                    actions={actions}
                    placeholder="2"
                    hint="同时运行的 CLI 任务数（1–8）"
                  />
                </div>
                <span className="dmc-hint">
                  任务描述命中某 CLI 的任务类型关键词时优先派发给该 CLI；都未命中时使用默认 CLI。关键词在「CLI 管理」各行的任务类型里配置。
                </span>
              </div>
              <div className="dmc-group">
                <p className="dmc-grouptitle">工具注入</p>
                <div className="dmc-field">
                  <Toggle
                    checked={values.bridgeMcp === true}
                    label="桥接 dsh 的 MCP 服务器到子代理"
                    onChange={value => { actions.setImmediate('bridgeMcp', value) }}
                  />
                  <span className="dmc-hint">开启后，派发的子代理能看到 dsh 自身配置的 MCP 服务器（stdio）。</span>
                </div>
              </div>
            </div>
          </div>
          <div className="dmc-row">
            <div className="dmc-body">
              <div className="dmc-group">
                <p className="dmc-grouptitle">主会话提示词预览</p>
                <span className="dmc-hint">宿主注入主会话系统提示的路由说明（随当前配置生成）。</span>
                {hint.error !== ''
                  ? <div className="dmc-banner dmc-banner-err">{hint.error}</div>
                  : <div className="dmc-log">{hint.text === '' ? '加载中…' : hint.text}</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'tasks' && (
        <div className="dmc-stack">
          <div className="dmc-row">
            <div className="dmc-body">
              <div className="dmc-group">
                <p className="dmc-grouptitle">手动派发 · 冒烟测试</p>
                <div className="dmc-grid">
                  <SelectField label="CLI" value={dispatchCli} options={[{ value: 'auto', label: '自动路由' }, ...CLI_OPTIONS]} onChange={setDispatchCli} />
                  <CwdField label="执行目录" value={dispatchCwd} workspaces={workspaces} onChange={setDispatchCwd} />
                </div>
                <Field label="任务描述" wide>
                  <textarea
                    className="dmc-textarea"
                    style={{ minHeight: 48 }}
                    placeholder="手动派发一个任务做冒烟测试（等同主会话调用 dispatch 工具）"
                    value={dispatchTask}
                    onChange={event => { setDispatchTask(event.target.value) }}
                  />
                </Field>
                <div className="dmc-toolbar">
                  <button
                    type="button"
                    className="dmc-btn dmc-btn-primary"
                    disabled={busy !== '' || dispatchTask.trim() === ''}
                    onClick={() => { void runDispatch() }}
                  >派发任务</button>
                </div>
              </div>
            </div>
          </div>

          <div className="dmc-row">
            <div className="dmc-body">
              <div className="dmc-group">
                <p className="dmc-grouptitle">任务记录</p>
                {overviewError !== '' && <div className="dmc-banner dmc-banner-err">无法连接宿主路由：{overviewError}</div>}
                <div className="dmc-stack" style={{ gap: 6 }}>
                  {tasks.map(task => (
                    <div
                      key={task.id}
                      className={task.id === selectedId ? 'dmc-taskrow dmc-taskrow-active' : 'dmc-taskrow'}
                      onClick={() => { setSelectedId(task.id === selectedId ? '' : task.id) }}
                    >
                      <PhaseChip phase={task.phase} />
                      <span className="dmc-dot" style={{ background: CLI_BRAND[task.cli] }} title={CLI_LABELS[task.cli]} />
                      <span className="dmc-tasktitle" title={task.title}>{task.title}</span>
                      <span className="dmc-tasktime">{new Date(task.startedAt).toLocaleTimeString()}</span>
                      {task.phase === 'running' || task.phase === 'queued'
                        ? (
                          <button
                            type="button"
                            className="dmc-btn dmc-btn-sm dmc-btn-danger"
                            onClick={event => {
                              event.stopPropagation()
                              void withBusy(`cancel-${task.id}`, () => cancelTask(task.id))
                            }}
                          >取消</button>
                        )
                        : undefined}
                    </div>
                  ))}
                  {tasks.length === 0 && <div className="dmc-hint">暂无任务记录</div>}
                </div>
                {detail !== undefined && (
                  <div>
                    <div className="dmc-log">
                      {detail.events.map(event => (
                        <div key={event.seq}>{`[${new Date(event.at).toLocaleTimeString()}] ${event.kind === 'error' ? '✗ ' : ''}${event.text}`}</div>
                      ))}
                      {detail.finalText !== undefined && <div className="dmc-log-final">{detail.finalText}</div>}
                    </div>
                    {detail.error !== undefined && <div className="dmc-banner dmc-banner-err" style={{ marginTop: 8 }}>{detail.error}</div>}
                    {detail.stats !== undefined && Object.keys(detail.stats).length > 0 && (
                      <div className="dmc-chips" style={{ marginTop: 8 }}>
                        {Object.entries(detail.stats).map(([key, stat]) => (
                          <span key={key} className="dmc-chip dmc-chip-idle dmc-code">{key}: {String(stat)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {form.dirty.length > 0 && (
        <div className="dmc-savebar">
          <span className="dmc-savebar-text">
            {`有 ${String(form.dirty.length)} 处文本改动待保存 — 模型 / 路径 / 任务类型等保存后生效；开关与下拉即时生效。`}
            {form.invalid !== undefined && <span style={{ color: 'var(--dmc-danger)' }}>{`（${form.invalid.message}）`}</span>}
            {form.failed && <span style={{ color: 'var(--dmc-danger)' }}>上次保存未生效，请重试。</span>}
          </span>
          <button type="button" className="dmc-btn" onClick={() => { actions.discard() }}>放弃</button>
          <button
            type="button"
            className="dmc-btn dmc-btn-primary"
            disabled={!form.writable || form.saving}
            onClick={() => { void actions.save() }}
          >{form.saving ? '保存中…' : '保存修改'}</button>
        </div>
      )}
    </div>
  )
}
