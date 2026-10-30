/**
 * The plugin configuration card on the dsh settings page — "CLI 子代理".
 *
 * Tabbed layout, one concern per tab: per-CLI configuration (CLI 管理 — one
 * expandable row per CLI with model / task-type / permission / connection
 * settings), CLI binary management (SDK 管理 — one card per npm package with
 * a version picker, install / uninstall), routing defaults (调度设置) and the
 * task monitor (任务监视).
 *
 * Plain React + one injected stylesheet: the web shell has no CSS pipeline
 * and the card must be self-contained in the plugin bundle. The stylesheet
 * carries its own design tokens — host `--dsh-*` variables win when defined,
 * otherwise `light-dark()` adapts to the surrounding theme, so text keeps a
 * readable contrast on both light and dark shells.
 */

import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import {
  cancelTask, fetchCliVersions, fetchHint, fetchModels, fetchOverview, fetchTaskDetail,
  installCli, refreshCli, uninstallCli, type Call,
} from './api.js'
import { cliMinTaskDifficulty, fieldText, type MaestroFormActions, type MaestroFormState, type MaestroStore, type SectionValue, type StagedField } from './form.js'
import { formatDuration, formatTokens } from './board/model.js'
import type { BoardHost } from './board/data.js'
import { useUsageSummary } from './usage-panel.js'
import {
  cleanLogText, CLI_LABELS, CLI_PACKAGES, MAESTRO_CLI_IDS, TASK_TYPE_CATALOG, TERMINAL_PHASES,
  type DshProviderModels, type MaestroCliId, type MaestroCliVersions, type MaestroOverview, type MaestroPhase,
  type MaestroTaskDetail, type MaestroTaskSummary,
} from '../wire.js'

/** The props the slot entry injects (see client/index.ts). */
export interface MaestroCardProps {
  maestroStore: MaestroStore
  maestro: MaestroFormActions
  /** 客户端服务宿主（读会话 feed 里的 CLI 用量投影）；缺席时统计显示空态。 */
  maestroCtx?: BoardHost | undefined
}

/** Per-CLI identity colors, reused by the row monograms and the task list. */
const CLI_BRAND: Record<MaestroCliId, string> = { claude: '#d97757', codex: '#10a37f' }
const CLI_MONOGRAM: Record<MaestroCliId, string> = { claude: 'CL', codex: 'CX' }

const CLI_OPTIONS = MAESTRO_CLI_IDS.map(cli => ({ value: cli, label: CLI_LABELS[cli] }))

export const TASK_DIFFICULTY_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'extreme', label: '极高' },
] as const

/** One independent, immediately persisted task-difficulty selector per CLI. */
export function CliDifficultySelect(props: { cli: MaestroCliId; values: SectionValue; onChange: (value: string) => void }): ReactNode {
  return (
    <SelectField
      label={`${CLI_LABELS[props.cli]} 最低任务难度`}
      value={cliMinTaskDifficulty(props.values, props.cli)}
      options={TASK_DIFFICULTY_OPTIONS}
      onChange={props.onChange}
      hint="仅控制此 CLI；评估达到门槛才启动，未达门槛改用 dsh 子代理或由主代理直接完成。默认中；未单独设置时沿用旧的统一设置。"
    />
  )
}

/** SDK card titles / descriptions (dependency-manager wording, per CLI). */
const SDK_TITLES: Record<MaestroCliId, string> = {
  claude: 'Claude Code SDK',
  codex: 'Codex SDK',
}
const SDK_DESCRIPTIONS: Record<MaestroCliId, string> = {
  claude: 'Claude AI 功能所需。包含 Claude Code SDK 及相关依赖。',
  codex: 'Codex AI 功能所需。包含 OpenAI Codex SDK。',
}

/** Task-monitor owner labels: every row there is an external CLI subagent. */
const SUBAGENT_LABELS: Record<MaestroCliId, string> = {
  claude: 'claude 子代理',
  codex: 'codex 子代理',
}

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
  gap: 18px;
  max-width: 880px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--dmc-fg);
}
.dmc, .dmc *, .dmc *::before, .dmc *::after { box-sizing: border-box; }

/* --- header --- */
.dmc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dmc-title { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.01em; }
.dmc-subtitle { margin: 3px 0 0; font-size: 12.5px; color: var(--dmc-fg3); }
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
/* Accordion headers and details stack vertically. Header chip styles use
 * a separate dmch-* namespace so their horizontal rows cannot leak here. */
.dmc-row { display: flex; flex-direction: column; align-items: stretch; min-width: 0; border: 1px solid var(--dmc-border); border-radius: 12px; background: var(--dmc-panel); overflow: hidden; }
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
.dmc-body { padding: 16px; display: flex; flex-direction: column; gap: 22px; }

/* --- groups & fields ---
 * Vertical rhythm: a group is a heading plus its body (6px apart); groups are
 * 22px apart, so heading→content always reads tighter than heading→heading. */
.dmc-group { display: flex; flex-direction: column; gap: 6px; }
.dmc-grouptitle { margin: 0; font-size: 13.5px; font-weight: 600; letter-spacing: -.005em; color: var(--dmc-fg); }
.dmc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 18px; }
/* The model + thinking-level pair: one row, model left and level right (each
 * half the width); they stack only once a column can no longer reach 240px. */
.dmc-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px 18px; }
.dmc-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dmc-fieldwide { grid-column: 1 / -1; }
.dmc-label { font-size: 12.5px; font-weight: 550; color: var(--dmc-fg2); display: flex; align-items: center; gap: 6px; }
.dmc-dirty { width: 6px; height: 6px; border-radius: 999px; background: var(--dmc-warn); flex: none; }
.dmc-hint { font-size: 11.5px; color: var(--dmc-fg3); line-height: 1.5; }

/* --- advanced (collapsed connection settings) --- */
.dmc-advanced { border-top: 1px dashed var(--dmc-border); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.dmc-advanced > summary { font-size: 12.5px; font-weight: 550; color: var(--dmc-fg2); cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; user-select: none; }
.dmc-advanced > summary::-webkit-details-marker { display: none; }
.dmc-advanced > summary::before { content: '▸'; font-size: 10px; color: var(--dmc-fg3); transition: transform .15s; }
.dmc-advanced[open] > summary::before { transform: rotate(90deg); }
.dmc-advanced[open] > summary { margin-bottom: 2px; }

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

/* --- toggle switch ---
 * .dmc-switch (the label) is the only click target: as a flex child the outer
 * wrapper stretches across the field, and a label around everything would make
 * the whole row flip the switch. */
.dmc-toggle { position: relative; display: inline-flex; align-items: center; gap: 8px; user-select: none; }
.dmc-switch { position: relative; display: inline-flex; cursor: pointer; }
.dmc-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.dmc-track { width: 32px; height: 18px; border-radius: 999px; background: color-mix(in srgb, var(--dmc-fg3) 45%, transparent); position: relative; transition: background .18s; flex: none; }
.dmc-switch input:checked + .dmc-track { background: var(--dmc-accent); }
.dmc-switch input:focus-visible + .dmc-track { outline: 2px solid var(--dmc-accent); outline-offset: 2px; }
.dmc-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: left .18s; }
.dmc-switch input:checked + .dmc-track .dmc-knob { left: 16px; }
.dmc-switch input:disabled + .dmc-track { opacity: .45; cursor: not-allowed; }
.dmc-togglelabel { font-size: 12.5px; }

/* --- save bar --- */
.dmc-savebar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--dmc-warn) 40%, transparent); background: color-mix(in srgb, var(--dmc-warn) 8%, var(--dmc-panel)); box-shadow: 0 -4px 14px rgba(0,0,0,.08); }
.dmc-savebar-text { flex: 1; min-width: 220px; font-size: 12px; color: var(--dmc-fg2); }

/* --- task-type cards (highlight only, no check mark) --- */
.dmc-typegrid { display: flex; flex-wrap: wrap; gap: 6px; }
.dmc-typecard { appearance: none; display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--dmc-border); background: var(--dmc-input); color: var(--dmc-fg2); font-size: 12px; font-weight: 500; cursor: pointer; transition: background .15s, border-color .15s, color .15s; }
.dmc-typecard:hover { background: var(--dmc-hover); }
.dmc-typecard-on { border-color: color-mix(in srgb, var(--dmc-accent) 55%, transparent); background: var(--dmc-accent-soft); color: var(--dmc-accent); font-weight: 600; }
.dmc-typecard:focus-visible { outline: 2px solid var(--dmc-accent); outline-offset: 2px; }

/* --- SDK cards (one per CLI, dependency-manager layout) --- */
.dmc-sdkcard { border: 1px solid var(--dmc-border); border-radius: 12px; background: var(--dmc-panel); padding: 14px 16px; display: flex; flex-direction: column; gap: 11px; }
.dmc-sdkhead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dmc-sdkcheck { width: 18px; height: 18px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: var(--dmc-ok); background: color-mix(in srgb, var(--dmc-ok) 15%, transparent); flex: none; }
.dmc-sdkcheck-off { color: var(--dmc-fg3); background: color-mix(in srgb, var(--dmc-fg3) 15%, transparent); }
.dmc-sdkname { font-size: 14px; font-weight: 650; }
.dmc-sdkver { font-size: 12px; color: var(--dmc-fg2); font-variant-numeric: tabular-nums; }
.dmc-sdkarrow { color: var(--dmc-fg3); font-size: 12px; }
.dmc-sdkdesc { margin: 0; font-size: 12px; color: var(--dmc-fg3); }
.dmc-sdkfield { display: flex; flex-direction: column; gap: 4px; }
.dmc-sdkactions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dmc-sdkmeta { font-size: 11.5px; color: var(--dmc-fg3); display: flex; gap: 14px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.dmc-sdkpath { border-top: 1px solid var(--dmc-border); padding-top: 9px; display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dmc-fg3); min-width: 0; }
.dmc-sdkpath span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace; }
.dmc-sdkloading { font-size: 11.5px; color: var(--dmc-fg3); }

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
.dmc-taskbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dmc-taskowner { flex: none; font-size: 11px; font-weight: 600; color: var(--dmc-fg2); padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dmc-border); background: var(--dmc-panel); }
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

/**
 * A toggle switch (the native checkbox stays in the tree for a11y). Only the
 * switch itself is the click target: the wrapping element stretches to the
 * field's full width as a flex child, so a `<label>` around the whole thing
 * made every click in that row flip the switch — the text sits outside it.
 */
function Toggle(props: { checked: boolean; onChange: (value: boolean) => void; label?: string | undefined; disabled?: boolean | undefined }): ReactNode {
  return (
    <span className="dmc-toggle">
      <label className="dmc-switch">
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          aria-label={props.label}
          onChange={event => { props.onChange(event.target.checked) }}
        />
        <span className="dmc-track"><span className="dmc-knob" /></span>
      </label>
      {props.label === undefined ? undefined : <span className="dmc-togglelabel">{props.label}</span>}
    </span>
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
  onChange: (value: string) => void; hint?: string | undefined; disabled?: boolean | undefined
}): ReactNode {
  return (
    <Field label={props.label} hint={props.hint}>
      <select className="dmc-select" value={props.value} disabled={props.disabled} onChange={event => { props.onChange(event.target.value) }}>
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

/** The dsh-model select: `<provider>::<model>` options grouped by provider, filtered by CLI protocol. */
function DshModelSelect(props: {
  cli: MaestroCliId; value: string; providers: DshProviderModels[] | undefined; onChange: (value: string) => void
}): ReactNode {
  // codex drives every OpenAI-compatible dsh provider over the responses
  // dialect, no matter whether dsh declared it openai-responses or
  // openai-completions (verified live: ofox/xm/tokenrhythm all answer
  // /responses), so both are offered. claude stays anthropic-only.
  const usableApis: readonly string[] = props.cli === 'claude'
    ? ['anthropic-messages']
    : ['openai-responses', 'openai-completions']
  const providers = props.providers ?? []
  const mappable = providers.filter(provider => provider.mappable && usableApis.includes(provider.api))
  // No `hint` and no `wide`: the label alone, and the thinking level sits to
  // the right of this picker on the same row (see the 模型 group), so each
  // takes half the row.
  return (
    <Field label="dsh 模型">
      <select className="dmc-select" value={props.value} onChange={event => { props.onChange(event.target.value) }}>
        <option value="">沿用主代理模型（主代理协议不兼容时任务直接报错）</option>
        {mappable.map(provider => (
          <optgroup key={provider.id} label={`${provider.displayName}（${provider.api}${provider.models.length === 0 ? '' : ` · ${String(provider.models.length)} 个模型`}）`}>
            {provider.models.map(model => (
              <option key={`${provider.id}::${model.id}`} value={`${provider.id}::${model.id}`}>{model.id}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  )
}

/** One CLI's npm registry versions, or the failure that kept them away. */
interface RegistryVersions {
  latest: string
  versions: string[]
  platform: string
  error: string
}

const NO_HOST: BoardHost = { get: () => undefined }

/**
 * 任务监视页顶部的「用量统计」：把各会话的 `maestroCliUsage` 投影折成近 7 天
 * 的汇总。会话 feed 缺席时显示空态，绝不挡住任务记录。
 */
export function UsageGroup(props: { ctx: BoardHost | undefined }): ReactNode {
  const usage = useUsageSummary(props.ctx ?? NO_HOST)
  return (
    <div className="dmc-group">
      <p className="dmc-grouptitle">用量统计（最近 7 天）</p>
      {usage.requests === 0 ? (
        <span className="dmc-hint">近 7 天还没有 CLI 调用。每次派发结算后计入所属会话的 maestroCliUsage 投影（每会话保留最近 20 次明细）。</span>
      ) : (
        <>
          <div className="dmc-chips">
            <StateChip tone="accent">{`调用 ${String(usage.requests)}`}</StateChip>
            <StateChip tone="ok">{`成功 ${String(usage.ok)}`}</StateChip>
            {usage.failed > 0 && <StateChip tone="err">{`失败 ${String(usage.failed)}`}</StateChip>}
            {usage.cancelled > 0 && <StateChip tone="idle">{`取消 ${String(usage.cancelled)}`}</StateChip>}
            <StateChip tone="idle">{`入 ${formatTokens(usage.inputTokens)} · 出 ${formatTokens(usage.outputTokens)} · 缓存 ${formatTokens(usage.cachedInputTokens)}`}</StateChip>
            <StateChip tone="idle">{`总耗时 ${formatDuration(usage.durationMs)}`}</StateChip>
          </div>
          {MAESTRO_CLI_IDS.map(cli => {
            const bucket = usage.perCli[cli]
            if (bucket === undefined || bucket.requests === 0) return undefined
            return (
              <div key={cli} className="dmc-sdkmeta">
                <span style={{ color: CLI_BRAND[cli], fontWeight: 600 }}>{CLI_LABELS[cli]}</span>
                <span>{`调用 ${String(bucket.requests)}`}</span>
                <span>{`成功 ${String(bucket.ok)}`}</span>
                {bucket.failed > 0 && <span style={{ color: 'var(--dmc-danger)' }}>{`失败 ${String(bucket.failed)}`}</span>}
                <span>{`入 ${formatTokens(bucket.inputTokens)} · 出 ${formatTokens(bucket.outputTokens)}`}</span>
                <span>{`累计 ${formatDuration(bucket.durationMs)}`}</span>
              </div>
            )
          })}
          {usage.recent.map(record => (
            <div key={record.taskId} className="dmc-code">
              {`${new Date(record.startedAt).toLocaleTimeString()}  ${CLI_LABELS[record.cli]}${record.model === '' ? '' : ` · ${record.model}`} · ${record.phase === 'done' ? '成功' : record.phase === 'cancelled' ? '已取消' : '失败'} · ${formatDuration(record.durationMs)}`}
            </div>
          ))}
        </>
      )}
      <span className="dmc-hint">重启后仍可翻看的结果保存在 $DSH_HOME/maestro/tasks（可在「调度设置」关闭）。</span>
    </div>
  )
}

/** The events a task's log view keeps (oldest pages drop first). */
const DETAIL_EVENT_CAP = 400

/**
 * Fold one polled detail page into the accumulated view. Events only ever
 * append (the cursor already dedupes); a phase change re-renders but must NOT
 * reset the transcript — that used to wipe every earlier log line the moment
 * the task completed.
 */
export function mergeTaskDetail(previous: MaestroTaskDetail | undefined, rest: MaestroTaskDetail): MaestroTaskDetail {
  if (previous === undefined) return rest
  return { ...rest, events: [...previous.events, ...rest.events].slice(-DETAIL_EVENT_CAP) }
}

/** The npm action one CLI is running right now; undefined = idle. */
export type NpmRunning = 'install' | 'uninstall' | undefined

/**
 * A click the card already fired: `id` is '' until the route answers with the
 * registry task id, `at` dates the click (a safety net against a job that
 * leaves the overview's newest-20 window before this card ever sees it end).
 */
export interface NpmClick {
  readonly id: string
  readonly action: 'install' | 'uninstall'
  readonly at: number
}

/** Max npm run time is 10 分钟 (cli-manager), so a click entry older than this is stale. */
const NPM_CLICK_TTL_MS = 15 * 60_000

/**
 * One CLI's live npm job, read off the overview: every install/uninstall is an
 * `npm-*` registry task, so a non-terminal one means `npm -g` still owns that
 * CLI's global install and the card must not start a second run.
 */
export function liveNpmTask(tasks: readonly MaestroTaskSummary[], cli: MaestroCliId): MaestroTaskSummary | undefined {
  return tasks.find(task => task.cli === cli && task.id.startsWith('npm-') && !TERMINAL_PHASES.includes(task.phase))
}

/**
 * Which action one CLI is running. The route titles install jobs 「安装…」 and
 * uninstall jobs 「卸载…」; a job the user just fired reports the action it was
 * fired with, because the button has to lock on the click, not on the next poll.
 */
export function npmRunningOf(
  tasks: readonly MaestroTaskSummary[], cli: MaestroCliId, click: NpmClick | undefined,
): NpmRunning {
  const live = liveNpmTask(tasks, cli)
  if (live === undefined) return click?.action
  if (click !== undefined && click.id === live.id) return click.action
  return live.title.startsWith('卸载') ? 'uninstall' : 'install'
}

/** Drop one CLI's entry from a per-CLI record (same object when it was absent). */
function withoutCli<T>(record: Partial<Record<MaestroCliId, T>>, cli: MaestroCliId): Partial<Record<MaestroCliId, T>> {
  if (record[cli] === undefined) return record
  const next = { ...record }
  delete next[cli]
  return next
}

/** Labels and enabled flags of one SDK card's two action buttons. */
export interface SdkActionButtons {
  readonly installLabel: string
  readonly installDisabled: boolean
  readonly uninstallLabel: string
  readonly uninstallDisabled: boolean
  /** An npm job (or a click already fired) holds this CLI: lock the row's pickers too. */
  readonly locked: boolean
}

/**
 * The SDK card's install/uninstall buttons for one CLI. A running npm job or a
 * click that already fired turns the matching button into 「安装中…」/「卸载中…」
 * and disables both — that is what makes a second click a no-op instead of a
 * duplicate `npm -g` run (the route also answers 409 as a second line of
 * defence, but the button must not ask in the first place).
 */
export function sdkActionButtons(input: {
  running: NpmRunning
  /** Any card-wide request is in flight (busy !== ''). */
  busy: boolean
  installed: boolean
  current: string
  selected: string
}): SdkActionButtons {
  const locked = input.busy || input.running !== undefined
  const sameAsCurrent = input.installed && input.selected === input.current
  const idleInstallLabel = sameAsCurrent
    ? '当前版本'
    : input.selected === ''
      ? '安装最新版'
      : `安装 v${input.selected}`
  return {
    installLabel: input.running === 'install' ? '安装中…' : idleInstallLabel,
    installDisabled: locked || sameAsCurrent,
    uninstallLabel: input.running === 'uninstall' ? '卸载中…' : '卸载',
    uninstallDisabled: locked || !input.installed,
    locked,
  }
}

export function MaestroCard(props: MaestroCardProps): ReactNode {
  useStyles()
  const form = useStore(props.maestroStore)
  const actions = props.maestro
  const values = form.values

  const [tab, setTab] = useState<TabId>('cli')
  const [openCli, setOpenCli] = useState<MaestroCliId | undefined>(undefined)

  const [overview, setOverview] = useState<MaestroOverview | undefined>(undefined)
  const [overviewError, setOverviewError] = useState('')
  const [dshProviders, setDshProviders] = useState<DshProviderModels[] | undefined>(undefined)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  // SDK tab: the npm job each card just fired. The overview poll is the source
  // of truth for a running job, but it lands up to 4s later — this optimistic
  // entry locks the card on the click itself, so a double click can never start
  // a second `npm -g` run. `id` is '' until the route answers.
  const [npmClicks, setNpmClicks] = useState<Partial<Record<MaestroCliId, NpmClick>>>({})

  // SDK tab: each CLI's published versions (loaded on demand) and the version
  // each card's picker currently points at.
  const [registryVersions, setRegistryVersions] = useState<Partial<Record<MaestroCliId, RegistryVersions>>>({})
  const [versionDraft, setVersionDraft] = useState<Partial<Record<MaestroCliId, string>>>({})

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

  // The SDK tab's version pickers: load each CLI's registry versions once.
  useEffect(() => {
    if (tab !== 'sdk') return
    let disposed = false
    for (const cli of MAESTRO_CLI_IDS) {
      if (registryVersions[cli] !== undefined) continue
      void fetchCliVersions(cli).then(result => {
        if (disposed) return
        setRegistryVersions(previous => ({
          ...previous,
          [cli]: result.ok
            ? { latest: result.latest, versions: [...result.versions], platform: result.platform, error: '' }
            : { latest: '', versions: [], platform: '', error: result.error },
        }))
      })
    }
    return () => { disposed = true }
  }, [tab])

  // Refresh the routing hint on tab entry and immediate routing config changes.
  useEffect(() => {
    if (tab !== 'routing') return
    let disposed = false
    void fetchHint().then(result => {
      if (disposed) return
      setHint(result.ok ? { text: result.hint, error: '' } : { text: '', error: result.error })
    })
    return () => { disposed = true }
  }, [tab, values.minTaskDifficulty, values.claudeMinTaskDifficulty, values.codexMinTaskDifficulty, values.defaultCli, values.claudeTaskTypes, values.codexTaskTypes, values.claudeEnabled, values.codexEnabled])

  // Poll the selected task's detail until it settles: a terminal phase stops
  // the timer instead of polling a finished task forever.
  useEffect(() => {
    if (selectedId === '') {
      setDetail(undefined)
      return
    }
    let disposed = false
    let cursor = 0
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = async (): Promise<void> => {
      const result = await fetchTaskDetail(selectedId, cursor)
      if (disposed || !result.ok) return
      const { ok: _ok, ...rest } = result
      cursor = rest.nextCursor
      setDetail(previous => mergeTaskDetail(previous, rest))
      if (TERMINAL_PHASES.includes(rest.summary.phase) && timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
    void tick()
    timer = setInterval(() => { void tick() }, 2000)
    return () => { disposed = true; if (timer !== undefined) clearInterval(timer) }
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

  /** npm install one version (empty = registry latest) / uninstall (confirm first). */
  const npmAction = (cli: MaestroCliId, action: 'install' | 'uninstall', version?: string): void => {
    if (action === 'uninstall' && globalThis.confirm(`确认卸载 ${CLI_PACKAGES[cli]}？（npm -g uninstall）`) === false) return
    // Lock before the request leaves: the overview poll is the long-term source
    // of truth, but it is up to 4s behind, and that window was exactly where a
    // second click started a duplicate npm job.
    setNpmClicks(previous => ({ ...previous, [cli]: { id: '', action, at: Date.now() } }))
    void (async () => {
      const result = await withBusy(`${action}-${cli}`, () => action === 'install'
        ? installCli(cli, version === undefined || version === '' ? undefined : version)
        : uninstallCli(cli))
      if (!result.ok) {
        // The route refused (409 = another npm job of this CLI is running):
        // drop the optimistic lock and let the overview report the real one.
        setNpmClicks(previous => withoutCli(previous, cli))
        return
      }
      // Keep the lock under the real task id so the poll cannot unlock it early.
      setNpmClicks(previous => ({ ...previous, [cli]: { id: result.id, action, at: Date.now() } }))
      if (action === 'install') {
        setVersionDraft(previous => {
          const next = { ...previous }
          delete next[cli]
          return next
        })
      }
      // The npm job may still be running; re-detect to pick the new binary up.
      await withBusy(`refresh-${cli}`, () => refreshCli(cli))
    })()
  }

  const refreshAll = (): void => { void withBusy('refresh', () => refreshCli()) }

  const tasks = overview?.tasks ?? []
  const activeCount = tasks.filter(task => task.phase === 'running' || task.phase === 'queued').length

  // Retire an optimistic npm click once the overview reports its task settled,
  // then re-detect that CLI: the install request answers immediately, so the
  // refresh fired right after it runs while `npm -g` is still writing and sees
  // the old version. The TTL only catches a job that left the newest-20 window
  // before we saw it end, so a stuck 「安装中…」 cannot outlive the npm timeout.
  useEffect(() => {
    if (Object.keys(npmClicks).length === 0) return
    const listed = overview?.tasks ?? []
    const next: Partial<Record<MaestroCliId, NpmClick>> = { ...npmClicks }
    const settled: MaestroCliId[] = []
    for (const cli of MAESTRO_CLI_IDS) {
      const click = next[cli]
      if (click === undefined || click.id === '') continue
      const task = listed.find(entry => entry.id === click.id)
      if (task !== undefined && TERMINAL_PHASES.includes(task.phase)) {
        delete next[cli]
        settled.push(cli)
      } else if (task === undefined && Date.now() - click.at > NPM_CLICK_TTL_MS) {
        delete next[cli]
      }
    }
    if (settled.length > 0 || Object.keys(next).length !== Object.keys(npmClicks).length) setNpmClicks(next)
    for (const cli of settled) void withBusy(`refresh-${cli}`, () => refreshCli(cli))
  }, [overview, npmClicks])

  /** This CLI's optimistic lock, ignoring an entry that already outlived the npm timeout. */
  const npmClickOf = (cli: MaestroCliId): NpmClick | undefined => {
    const click = npmClicks[cli]
    if (click === undefined) return undefined
    if (click.id !== '' && Date.now() - click.at > NPM_CLICK_TTL_MS) return undefined
    return click
  }

  /** The dsh model selection of one CLI (`provider::model`, '' = follow the main agent). */
  const dshSelectionOf = (cli: MaestroCliId): string =>
    String(cli === 'claude' ? values.claudeDshModel ?? '' : values.codexDshModel ?? '')

  /**
   * The reasoning efforts the selected dsh model declares (the thinking-level
   * options ride the model's own configuration). '' selection or a model no
   * longer in the catalog yields nothing — only the CLI default remains.
   */
  const reasoningLevelsOf = (selection: string): readonly string[] => {
    const at = selection.indexOf('::')
    if (at <= 0) return []
    const provider = (dshProviders ?? []).find(entry => entry.id === selection.slice(0, at))
    return provider?.models.find(model => model.id === selection.slice(at + 2))?.reasoningEfforts ?? []
  }

  /** The model summary shown on a collapsed CLI row. */
  const modelSummary = (cli: MaestroCliId): string => {
    const dsh = dshSelectionOf(cli)
    const thinking = String(cli === 'claude' ? values.claudeThinking ?? '' : values.codexThinking ?? '')
    const thinkingLabel = thinking === '' ? '' : ` · 思考 ${thinking}`
    return `${dsh === '' ? '沿用主代理模型' : `dsh 模型 ${dsh}`}${thinkingLabel}`
  }

  const statusOf = (cli: MaestroCliId) => overview?.clis?.[cli]

  /** One expandable CLI row (tab 1): identity, status, and the config panel. */
  const cliRow = (cli: MaestroCliId): ReactNode => {
    const open = openCli === cli
    const status = statusOf(cli)
    const enabled = cli === 'claude' ? values.claudeEnabled === true : values.codexEnabled === true
    const taskTypes: readonly string[] = (cli === 'claude' ? values.claudeTaskTypes : values.codexTaskTypes) ?? []
    const taskTypeField = cli === 'claude' ? 'claudeTaskTypes' : 'codexTaskTypes'
    const toggleTaskType = (type: string): void => {
      const next = taskTypes.includes(type) ? taskTypes.filter(entry => entry !== type) : [...taskTypes, type]
      actions.setImmediate(taskTypeField, next)
    }
    const selection = dshSelectionOf(cli)
    const thinkingValue = String(cli === 'claude' ? values.claudeThinking ?? '' : values.codexThinking ?? '')
    // The thinking options ARE the selected model's configured reasoningEfforts.
    const levels = reasoningLevelsOf(selection)
    const thinkingOptions: Array<{ value: string; label: string }> = [
      { value: '', label: '默认（CLI 自身行为）' },
      ...levels.map(level => ({ value: level, label: level })),
    ]
    // A value set before the model changed (or in the config file) stays visible.
    if (thinkingValue !== '' && !levels.includes(thinkingValue)) {
      thinkingOptions.push({ value: thinkingValue, label: `${thinkingValue}（当前模型未列出）` })
    }
    const changeModel = (value: string): void => {
      actions.setImmediate(cli === 'claude' ? 'claudeDshModel' : 'codexDshModel', value)
      // A level the new model doesn't declare would ride every later dispatch — reset it.
      if (thinkingValue !== '' && !reasoningLevelsOf(value).includes(thinkingValue)) {
        actions.setImmediate(cli === 'claude' ? 'claudeThinking' : 'codexThinking', '')
      }
    }
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
              {`${modelSummary(cli)} · ${String(taskTypes.length)} 类任务 · 最低难度 ${TASK_DIFFICULTY_OPTIONS.find(option => option.value === cliMinTaskDifficulty(values, cli))?.label ?? '中'}`}
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
              <div className="dmc-pair">
                <DshModelSelect
                  cli={cli}
                  value={selection}
                  providers={dshProviders}
                  onChange={changeModel}
                />
                <SelectField
                  label="思考等级"
                  value={thinkingValue}
                  options={thinkingOptions}
                  disabled={levels.length === 0 && thinkingValue === ''}
                  onChange={value => { actions.setImmediate(cli === 'claude' ? 'claudeThinking' : 'codexThinking', value) }}
                />
              </div>
            </div>

            <CliDifficultySelect
              cli={cli}
              values={values}
              onChange={value => { actions.setImmediate(cli === 'claude' ? 'claudeMinTaskDifficulty' : 'codexMinTaskDifficulty', value) }}
            />

            <Field
              label="任务类型"
              wide
              hint="关键词只用于选择此 CLI；还须达到此 CLI 的最低任务难度才会派发，全部未命中时用「调度设置」里的默认 CLI。"
            >
              <div className="dmc-typegrid">
                {[...TASK_TYPE_CATALOG, ...taskTypes.filter(type => !TASK_TYPE_CATALOG.includes(type))].map(type => {
                  const on = taskTypes.includes(type)
                  return (
                    <button
                      key={type}
                      type="button"
                      className={on ? 'dmc-typecard dmc-typecard-on' : 'dmc-typecard'}
                      aria-pressed={on}
                      onClick={() => { toggleTaskType(type) }}
                    >{type}</button>
                  )
                })}
              </div>
            </Field>

            <div className="dmc-group">
              <p className="dmc-grouptitle">权限</p>
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
              </div>
            </div>

            <details className="dmc-advanced">
              <summary>高级连接设置（一般不需要改）</summary>
              <div className="dmc-grid">
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
                  label="连续无输出超时（分钟）"
                  field={cli === 'claude' ? 'claudeTimeoutMinutes' : 'codexTimeoutMinutes'}
                  state={form}
                  actions={actions}
                  placeholder="20"
                  hint="1–240，连续无 stdout/stderr 输出达到该时长才终止；不是总运行时限"
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
              <span className="dmc-hint">API 地址 / Token 让 CLI 走自定义兼容端点；CLI 路径留空自动从 PATH 检测；CLI 非空输出会重置无输出超时计时，不因总运行时长到点强制终止。</span>
            </details>
          </div>
        )}
      </div>
    )
  }

  /** One SDK card (tab 2): dependency-manager layout — status header, version picker, actions, path. */
  const sdkRow = (cli: MaestroCliId): ReactNode => {
    const status = statusOf(cli)
    const installed = status?.installed === true
    const current = installed ? status.version : ''
    const registry = registryVersions[cli]
    const loading = registry === undefined
    const latest = registry?.latest ?? ''
    const options = registry?.versions ?? []
    const selected = versionDraft[cli] ?? current
    const hasUpdate = installed && latest !== '' && current !== '' && current !== latest
    // A live `npm-*` job (or the click that just fired one) owns this CLI: the
    // buttons say 「安装中…」/「卸载中…」 and the whole row is locked until it ends.
    const running = npmRunningOf(tasks, cli, npmClickOf(cli))
    const buttons = sdkActionButtons({ running, busy: busy !== '', installed, current, selected })
    const liveTask = liveNpmTask(tasks, cli)
    return (
      <div key={cli} className="dmc-sdkcard">
        <div className="dmc-sdkhead">
          <span className={installed ? 'dmc-sdkcheck' : 'dmc-sdkcheck dmc-sdkcheck-off'} aria-hidden>{installed ? '✓' : '·'}</span>
          <span className="dmc-sdkname">{SDK_TITLES[cli]}</span>
          <span className="dmc-sdkver">{current === '' ? '未安装' : `v${current}`}</span>
          {hasUpdate && (
            <>
              <span className="dmc-sdkarrow">→</span>
              <span className="dmc-sdkver">{`v${latest}`}</span>
              <StateChip tone="accent">有更新</StateChip>
            </>
          )}
          {running !== undefined && <StateChip tone="accent">{running === 'install' ? '安装中…' : '卸载中…'}</StateChip>}
          <span style={{ flex: 1 }} />
          <button type="button" className="dmc-btn dmc-btn-sm" disabled={busy !== '' || buttons.locked} onClick={() => { void withBusy(`refresh-${cli}`, () => refreshCli(cli)) }}>重新检测</button>
        </div>
        <p className="dmc-sdkdesc">{SDK_DESCRIPTIONS[cli]}</p>

        <Field label="目标版本" hint={`只列正式版（不含 alpha / beta）· 当前平台 ${registry?.platform ?? '—'}`}>
          <select
            className="dmc-select"
            value={selected}
            disabled={loading || options.length === 0 || buttons.locked}
            onChange={event => { setVersionDraft(previous => ({ ...previous, [cli]: event.target.value })) }}
          >
            <option value="">{loading ? '加载版本列表…' : (latest === '' ? '最新版' : `最新版（v${latest}）`)}</option>
            {options.map(version => (
              <option key={version} value={version}>{version === current ? `v${version}（当前）` : `v${version}`}</option>
            ))}
          </select>
        </Field>

        <div className="dmc-sdkactions">
          <button
            type="button"
            className="dmc-btn dmc-btn-primary"
            disabled={buttons.installDisabled}
            aria-busy={running === 'install'}
            onClick={() => { npmAction(cli, 'install', selected) }}
          >{buttons.installLabel}</button>
          <button
            type="button"
            className="dmc-btn dmc-btn-danger"
            disabled={buttons.uninstallDisabled}
            aria-busy={running === 'uninstall'}
            onClick={() => { npmAction(cli, 'uninstall') }}
          >{buttons.uninstallLabel}</button>
          {loading && <span className="dmc-sdkloading">正在读取 npm registry 版本…</span>}
          {running !== undefined && (
            <span className="dmc-sdkloading">
              {`npm ${running} 进行中${liveTask === undefined ? '' : `：${liveTask.id}`}，完成前不能重复执行，结束后自动重新检测版本`}
            </span>
          )}
        </div>

        <div className="dmc-sdkmeta">
          <span>{`当前版本 ${current === '' ? '—' : `v${current}`}`}</span>
          <span>{`最新稳定版 ${latest === '' ? (loading ? '加载中…' : '—') : `v${latest}`}`}</span>
        </div>

        {registry !== undefined && registry.error !== '' && (
          <div className="dmc-banner dmc-banner-err">{`无法读取 npm registry：${registry.error}`}</div>
        )}
        {status?.error !== undefined && status.error !== '' && (
          <div className="dmc-banner dmc-banner-err">{status.error}</div>
        )}

        <div className="dmc-sdkpath">
          <span aria-hidden>📁</span>
          <span title={installed ? status.path : CLI_PACKAGES[cli]}>
            {installed ? status.path : `未安装 · npm -g ${CLI_PACKAGES[cli]}`}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="dmc">
      <header className="dmc-head">
        <div>
          <h3 className="dmc-title">CLI 子代理</h3>
          <p className="dmc-subtitle">把任务按类型派发给 codex / claude 子代理（headless），取回结果回填主会话</p>
        </div>
        <div className="dmc-headside">
          {activeCount > 0 && <StateChip tone="accent">{`子代理运行中 ${String(activeCount)}`}</StateChip>}
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
          <div className="dmc-hint">「目标版本」来自 npm registry，可安装任意已发布版本；安装 / 卸载通过 npm -g 执行，过程与结果在「任务监视」标签页实时可见。registry 改动需保存。</div>
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
                  <StagedInput
                    label="失败自动重试"
                    field="failureRetries"
                    state={form}
                    actions={actions}
                    placeholder="0"
                    hint="普通失败后自动重跑的次数（0–2，默认 0）。会改文件的任务保持 0：重试可能叠加改动；超时与手动取消不重试。"
                  />
                </div>
                <span className="dmc-hint">
                  最低任务难度在「CLI 管理」的 Claude / Codex 中分别设置。主代理先判断任务是否需要开子代理，不需要就自己完成；需要时再评估难度并给出理由，按任务类型选择 CLI，达到该 CLI 的门槛才启动；未达门槛改用 dsh 子代理，不改选门槛更低的 CLI 绕过限制。仅指定 CLI 名称也不能绕过门槛。低：问答、查询、小范围编辑；中：常规多步骤任务；高：跨模块重构、复杂调试；极高：系统级设计或迁移。关键词只用于选 CLI，不用于抬高难度。
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
                <div className="dmc-field">
                  <Toggle
                    checked={values.persistTasks !== false}
                    label="保存任务结果到本地"
                    onChange={value => { actions.setImmediate('persistTasks', value) }}
                  />
                  <span className="dmc-hint">每次派发结算后把摘要与最终文本写入 $DSH_HOME/maestro/tasks（最多 200 条）；重启后「任务监视」仍能翻看历史。</span>
                </div>
                <div className="dmc-field">
                  <Toggle
                    checked={values.injectGitContext !== false}
                    label="自动注入 git 工作区快照"
                    onChange={value => { actions.setImmediate('injectGitContext', value) }}
                  />
                  <span className="dmc-hint">派发前把 cwd 的分支与未提交改动（git status 只读快照）拼在任务开头，CLI 子代理少猜一轮工作区状态。</span>
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
              <UsageGroup ctx={props.maestroCtx} />
            </div>
          </div>
          <div className="dmc-row">
            <div className="dmc-body">
              <div className="dmc-group">
                <p className="dmc-grouptitle">任务记录</p>
                <div className="dmc-taskbar">
                  <span className="dmc-chip dmc-chip-accent">{`CLI 子代理任务 ${String(tasks.length)}`}</span>
                  {activeCount > 0 && <span className="dmc-chip dmc-chip-warn">{`运行中 ${String(activeCount)}`}</span>}
                  <span className="dmc-hint">只有主会话通过 dispatch_cli_task 派发的任务会记录在这里；主智能体自己执行的工作不会出现。</span>
                </div>
                {overviewError !== '' && <div className="dmc-banner dmc-banner-err">无法连接宿主路由：{overviewError}</div>}
                <div className="dmc-stack" style={{ gap: 6 }}>
                  {tasks.map(task => (
                    <div
                      key={task.id}
                      className={task.id === selectedId ? 'dmc-taskrow dmc-taskrow-active' : 'dmc-taskrow'}
                      onClick={() => { setSelectedId(task.id === selectedId ? '' : task.id) }}
                    >
                      <PhaseChip phase={task.phase} />
                      <span className="dmc-dot" style={{ background: CLI_BRAND[task.cli] }} />
                      <span className="dmc-taskowner">{SUBAGENT_LABELS[task.cli]}</span>
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
                      {detail.summary.truncated === true && (
                        <div className="dmc-hint">事件过多，较早的日志已被裁剪（仅保留最近的事件）</div>
                      )}
                      {detail.events.map(event => (
                        <div key={event.seq}>{`[${new Date(event.at).toLocaleTimeString()}] ${event.kind === 'error' ? '✗ ' : ''}${cleanLogText(event.text)}`}</div>
                      ))}
                      {detail.finalText !== undefined && <div className="dmc-log-final">{cleanLogText(detail.finalText)}</div>}
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
            {`有 ${String(form.dirty.length)} 处文本改动待保存 — 模型 / 路径 / 超时等保存后生效；开关、下拉与任务类型即时生效。`}
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
