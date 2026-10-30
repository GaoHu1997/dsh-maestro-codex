/** Original DSH-better-sidebar 0.28.2 renderer API. See LICENSE and source-manifest.json. */
import type { ComponentProps } from 'react'
import type { AgentNodePopover, WorkflowNodePopover } from './.types/client/TasksPopovers.js'
import type { JobOutputWindow } from './.types/client/JobsDrawer.js'

export { TasksGraph, ViewModeToggle, FoldToggleButton } from './.types/client/TasksGraph.js'
export type { TasksGraphProps } from './.types/client/TasksGraph.js'
export { TasksTree } from './.types/client/TasksTree.js'
export type { TasksTreeProps } from './.types/client/TasksTree.js'
export { buildTasksModel, tasksEdges, foldGroupId, FOLD_IDLE_MIN } from './.types/client/tasks-model.js'
export type {
  TasksAgentNode, TasksFoldNode, TasksFoldKind, TasksNode, TasksNodeState,
  TasksNodeTask, TasksWorkflowNode, TasksModelInput, TasksEdge,
} from './.types/client/tasks-model.js'

export { AnchoredPopover } from './.types/client/AnchoredPopover.js'
export type { AnchoredPopoverProps } from './.types/client/AnchoredPopover.js'
export { AgentNodePopover, WorkflowNodePopover } from './.types/client/TasksPopovers.js'
export type AgentNodePopoverProps = ComponentProps<typeof AgentNodePopover>
export type WorkflowNodePopoverProps = ComponentProps<typeof WorkflowNodePopover>
export { JobsDrawer, JobOutputWindow, JOBS_DRAWER_COLLAPSE_AT } from './.types/client/JobsDrawer.js'
export type { JobsDrawerProps } from './.types/client/JobsDrawer.js'
export type JobOutputWindowProps = ComponentProps<typeof JobOutputWindow>
export { FloatingWindow } from './.types/client/FloatingWindow.js'
export type { FloatingWindowProps } from './.types/client/FloatingWindow.js'
export type { TreeJob } from './.types/client/subagent-jobs.js'
export { formatJobDuration, jobDotState, jobStatusLabel, isJobLive, orderJobs } from './.types/client/subagent-jobs.js'

export { ContextDiagnosticsHost, ContextDiagnosticsButton, ContextDiagnosticsAlert, diagnosticAddressOf } from './.types/client/context-diagnostics-ui.js'
export type { ContextDiagnostics, ContextDiagnosticTarget, ContextDiagnosticError, ContextDiagnosticsSnapshot } from './.types/client/context-diagnostics.js'
export type { SessionMetrics } from './.types/client/session-metrics.js'
export type { SubagentCatalogView } from './.types/client/subagent-catalog.js'
export type { TeamMemberRow } from './.types/client/team-projection.js'
export { teamProjectionOf, teamMembersOf } from './.types/client/team-projection.js'
export { TeamBoard } from './.types/client/TeamBoard.js'
export type { TeamBoardProps } from './.types/client/TeamBoard.js'
export { TaskWindow, MultilineField } from './.types/client/TaskWindow.js'
export type { TaskWindowProps } from './.types/client/TaskWindow.js'
export type * from './.types/context-types.js'
export type {
  WorkflowRunView, WorkflowRunStatus, WorkflowRunMemberView, WorkflowRunPhaseView,
  WorkflowAgentOutcome, WorkflowStopReason,
} from './.types/workflow-runs.js'
export type { ProcessActivity, ProcessActivitySummary } from './.types/process-activity.js'
export { attachLocale, attachBetterLocale, localeSignature, t, zh, en } from './.types/client/locales.js'
export * from './.types/client/tasks-graph-layout.js'
export { fitTransform, lerpTransform, GLIDE_MS } from './.types/client/tasks-view-glide.js'
export type { ViewTransform, FitInput } from './.types/client/tasks-view-glide.js'
export { easeOut, tweenBox, TWEEN_MS } from './.types/client/tasks-layout-tween.js'
export { createFrameBatcher } from './.types/client/frame-batcher.js'
export { useNarrowViewport, isNarrowWidth, useViewportSize, NARROW_MAX_WIDTH } from './.types/client/breakpoints.js'
export type { ViewportSize } from './.types/client/breakpoints.js'
