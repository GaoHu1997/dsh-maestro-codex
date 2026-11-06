/**
 * 「子智能体」设置导航项（左侧菜单）的图标 —— 方案 B · 层级树。
 *
 * 宿主对没有自定义 icon 的 `settings.section` 行回退成默认齿轮
 * （`navIcon(id)` → `IconSettingsOutlineMedium`）。这里通过
 * `settings.section.icon` slot（同 id = `maestro-codex`）换成一张组织树：
 * 顶部主节点向下统领两个子节点，直白表达“一个主代理委派多个子代理”，
 * 且在 16px 菜单尺寸下比分支/网络构图更稳、辨识度更高。
 *
 * 线稿风格：24 网格、`currentColor` 描边，跟随菜单项文字色（激活态自动变色）；
 * 线宽 1.9 与内核 16px 级图标的视觉重量对齐。
 *
 * @module dsh-maestro-codex/client/SettingsSectionIcon
 */

import type { ReactNode } from 'react'

/** 宿主 `settings.section.icon` slot 传给组件的 props。 */
export interface SettingsSectionIconProps {
  /** 像素边长，宿主菜单里传 16；缺省按 16。 */
  readonly size?: number
  /** 该行是否为当前激活项（颜色由 `currentColor` 决定，这里仅接收）。 */
  readonly active?: boolean
}

/**
 * 渲染层级树图标。
 * @param props - `{ size?: number; active?: boolean }`
 */
export function SettingsSectionIcon({ size = 16 }: SettingsSectionIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <circle cx="12" cy="4.4" r="2.3" />
      <circle cx="5" cy="19" r="2.3" />
      <circle cx="19" cy="19" r="2.3" />
      <path d="M12 6.7V10" />
      <path d="M5 10H19" />
      <path d="M5 10V16.7" />
      <path d="M19 10V16.7" />
    </svg>
  )
}
