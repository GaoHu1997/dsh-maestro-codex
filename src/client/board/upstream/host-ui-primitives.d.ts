/**
 * Structural declarations for the host-owned primitives used by the vendored renderer.
 * Runtime imports remain external and resolve through window.__ModuleLoader__.
 * Compatible with the original renderer's DSH 0.2.1-rc.1 primitive calls.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type {
    ButtonHTMLAttributes, Dispatch, HTMLAttributes, ReactNode, RefAttributes,
    RefObject, SetStateAction, SVGProps,
  } from 'react'

  export type StateDotState = 'ongoing' | 'warning' | 'idle' | 'done' | 'error'
  export type TagTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'quiet'
  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, RefAttributes<HTMLButtonElement> {
    variant?: 'ghost' | 'primary' | 'outline' | 'secondary' | undefined
    size?: 'sm' | 'md' | 'lg' | undefined
    icon?: ReactNode
  }
  export function Button(props: ButtonProps): ReactNode
  export function StateDot(props: HTMLAttributes<HTMLSpanElement> & { state: StateDotState; size?: number | undefined }): ReactNode
  export function Tag(props: HTMLAttributes<HTMLSpanElement> & { tone?: TagTone | undefined }): ReactNode
  export function MenuSurface(props: HTMLAttributes<HTMLDivElement> & { compact?: boolean | undefined }): ReactNode
  export function Switch(props: {
    checked: boolean
    onChange(checked: boolean): void
    label?: string | undefined
    disabled?: boolean | undefined
  }): ReactNode
  export function useDismissOnOutsidePointer(
    ref: RefObject<HTMLElement>, open: boolean, onDismiss: Dispatch<SetStateAction<boolean>>,
  ): void
  export interface TerminalBlockLabels {
    commandLine(line: number): string
    signal(signal: string): string
    exitCode(code: number): string
    noExitCode: string
    running: string
    failed: string
    done: string
    copy: string
    copied: string
    noOutput: string
    collapseAria: string
    collapse: string
    expandAria(hidden: number): string
    expand(hidden: number): string
  }
  export function TerminalBlock(props: {
    command: string
    output?: string | undefined
    running?: boolean | undefined
    runStateDot?: boolean | undefined
    maxLines?: number | undefined
    copyText?: string | undefined
    labels: TerminalBlockLabels
  }): ReactNode
  export type IconProps = SVGProps<SVGSVGElement> & { size?: number | undefined }
  export function IconRefreshOutlineRegular(props: IconProps): ReactNode
  export function IconChevronDownOutlineRegular(props: IconProps): ReactNode
  export function IconChevronUpOutlineRegular(props: IconProps): ReactNode
  export function IconChevronRightOutlineRegular(props: IconProps): ReactNode
  export function IconFullscreenOutlineRegular(props: IconProps): ReactNode
  export function IconLoadingOutlineRegular(props: IconProps): ReactNode
  export function IconTreeCornerRegular(props: IconProps): ReactNode
  export function IconAgentPresetOutlineRegular(props: IconProps): ReactNode
  export function IconBranchOutlineRegular(props: IconProps): ReactNode
  export function IconChecklistOutlineRegular(props: IconProps): ReactNode
  export function IconUserOutlineRegular(props: IconProps): ReactNode
  export function IconCodeOutlineRegular(props: IconProps): ReactNode
  export function IconEditOutlineRegular(props: IconProps): ReactNode
  export function IconEllipsisOutlineRegular(props: IconProps): ReactNode
  export function IconGlobeOutlineRegular(props: IconProps): ReactNode
  export function IconPlanOutlineRegular(props: IconProps): ReactNode
  export function IconPlayOutlineRegular(props: IconProps): ReactNode
  export function IconQuestionOutlineRegular(props: IconProps): ReactNode
  export function IconSearchOutlineRegular(props: IconProps): ReactNode
  export function IconThinkOutlineRegular(props: IconProps): ReactNode
  export function IconUsersOutlineRegular(props: IconProps): ReactNode
  export function IconRightUpOutlineRegular(props: IconProps): ReactNode
  export function IconCopyOutlineRegular(props: IconProps): ReactNode
  export function IconStopFillRegular(props: IconProps): ReactNode
  export function IconCloseFillRegular(props: IconProps): ReactNode
  export function IconCloseOutlineRegular(props: IconProps): ReactNode
  export function IconContextInjectionOutlineRegular(props: IconProps): ReactNode
  export function IconWarningTriangleOutlineRegular(props: IconProps): ReactNode
  export function IconCheckOutlineRegular(props: IconProps): ReactNode
  export function IconPlusOutlineRegular(props: IconProps): ReactNode
  export function IconTrashOutlineRegular(props: IconProps): ReactNode
  export function Pill(props: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean | undefined }): ReactNode
  export function Input(props: import('react').InputHTMLAttributes<HTMLInputElement>): ReactNode
  export type MenuEntry = { id: string; label?: ReactNode; icon?: ReactNode; submenu?: MenuEntry[]; type?: 'separator' }
  export function Menu(props: {
    open: boolean; onClose(): void; items: MenuEntry[]; onSelect(id: string): void;
    align?: 'start' | 'end'; portal?: boolean; compact?: boolean; anchor: ReactNode;
  }): ReactNode
  export function MarkdownDelegateProvider(props: {
    children?: ReactNode; openFile(destination: string, options?: { line?: number }): void;
  }): ReactNode
  export function MarkdownText(props: {
    text: string;
    labels: { code: { copyLabel: string; copiedLabel: string; toolbarLabels?: { codeLabel: string; wrapLabel: string; unwrapLabel: string } }; footnotes: string };
  }): ReactNode
}
