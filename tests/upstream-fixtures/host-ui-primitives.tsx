/** Test-only host primitive faces. The production bundle uses the host's own UI. */
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode; variant?: string; size?: string
}>(function HostButton({ children, icon, variant, size, ...props }, ref) {
  return <button {...props} ref={ref} data-host-variant={variant} data-host-size={size}>{icon}{children}</button>
})
export function StateDot({ state, size, ...props }: HTMLAttributes<HTMLSpanElement> & { state: string; size?: number }) {
  return <span {...props} data-host-state-dot={state} data-host-dot-size={size} />
}
export function Tag({ tone, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: string }) {
  return <span {...props} data-host-tag={tone} />
}
export function MenuSurface({ compact, ...props }: HTMLAttributes<HTMLDivElement> & { compact?: boolean }) {
  return <div {...props} data-host-menu-compact={compact} />
}
export function Switch(props: { checked: boolean; disabled?: boolean; label?: string; onChange(checked: boolean): void }) {
  return <label>{props.label}<input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={event => props.onChange(event.currentTarget.checked)} /></label>
}
export function TerminalBlock(props: { command: string; output?: string }) {
  return <pre data-host-terminal={props.command}>{props.output}</pre>
}
export function useDismissOnOutsidePointer(): void {}
/** MarkdownText 测试替身：正文直出（宿主 0.2 的排版管线在真实环境接管）。 */
export function MarkdownText({ text, labels, variant }: { text: string; labels?: unknown; variant?: string }) {
  void labels
  return <div data-host-markdown={variant ?? 'body'}>{text}</div>
}
/** DisclosureRow 测试替身：summary/details 语义，props 与宿主同形。 */
export function DisclosureRow({ icon, title, open, expandable, onToggle, expandOnRowClick, collapsedContent, children }: {
  icon?: ReactNode; title: string; open: boolean; expandable: boolean; onToggle: () => void
  expandOnRowClick?: boolean; collapsedContent?: ReactNode; children?: ReactNode
}) {
  return (
    <div data-host-disclosure={open ? 'open' : 'closed'} data-host-disclosure-expandable={expandable}>
      <div role="button" data-host-disclosure-title onClick={expandOnRowClick ? onToggle : undefined}>
        {icon}{title}
        {collapsedContent}
      </div>
      {open ? children : null}
    </div>
  )
}
const icon = (name: string) => (props: { size?: number }) => <svg aria-hidden="true" data-host-icon={name} width={props.size} height={props.size} />
export const IconRefreshOutlineRegular = icon('refresh')
export const IconChevronDownOutlineRegular = icon('chevron-down')
export const IconChevronUpOutlineRegular = icon('chevron-up')
export const IconChevronRightOutlineRegular = icon('chevron-right')
export const IconFullscreenOutlineRegular = icon('fullscreen')
export const IconLoadingOutlineRegular = icon('loading')
export const IconTreeCornerRegular = icon('tree-corner')
export const IconAgentPresetOutlineRegular = icon('agent-preset')
export const IconBranchOutlineRegular = icon('branch')
export const IconChecklistOutlineRegular = icon('checklist')
export const IconUserOutlineRegular = icon('user')
export const IconCodeOutlineRegular = icon('code')
export const IconEditOutlineRegular = icon('edit')
export const IconEllipsisOutlineRegular = icon('ellipsis')
export const IconGlobeOutlineRegular = icon('globe')
export const IconPlanOutlineRegular = icon('plan')
export const IconPlayOutlineRegular = icon('play')
export const IconQuestionOutlineRegular = icon('question')
export const IconSearchOutlineRegular = icon('search')
export const IconThinkOutlineRegular = icon('think')
export const IconUsersOutlineRegular = icon('users')
export const IconRightUpOutlineRegular = icon('right-up')
export const IconCopyOutlineRegular = icon('copy')
export const IconGaugeOutlineRegular = icon('gauge')
export const IconDatabaseOutlineRegular = icon('database')
export const IconStopFillRegular = icon('stop')
export const IconCloseFillRegular = icon('close-fill')
export const IconCloseOutlineRegular = icon('close-outline')
export const IconContextInjectionOutlineRegular = icon('context-injection')
export function Pill({ active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return <button {...props} data-host-pill-active={active} />
}
export function Menu({ anchor }: { anchor: ReactNode }) {
  return <div data-host-menu>{anchor}</div>
}
export const IconCheckOutlineRegular = icon('check')
export const IconPlusOutlineRegular = icon('plus')
export const IconTrashOutlineRegular = icon('trash')
export const IconWarningTriangleOutlineRegular = icon('warning')
