import { describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS, TASK_DIFFICULTIES, TASK_DIFFICULTY_LABELS, effectiveOf, type TaskDifficulty } from '../src/config.js'
import { CLI_IDS, assertTaskDifficulty, keywordScore, pickCli, routingHint, RoutingError, taskDifficultyError } from '../src/routing.js'

function config(overrides: Partial<ReturnType<typeof effectiveOf>> = {}): ReturnType<typeof effectiveOf> {
  return { ...effectiveOf({}), ...overrides }
}

describe('pickCli', () => {
  it('honors an explicit request', () => {
    expect(pickCli(config(), 'claude', '随便什么').cli).toBe('claude')
    expect(pickCli(config(), 'codex', '随便什么').reason).toBe('requested')
  })

  it('rejects an unknown CLI name', () => {
    expect(() => pickCli(config(), 'gemini', 'x')).toThrow(RoutingError)
  })

  it('falls back when the requested CLI is disabled', () => {
    const cfg = config({ claude: { ...effectiveOf({}).claude, enabled: false } })
    const decision = pickCli(cfg, 'claude', 'x')
    expect(decision.cli).toBe('codex')
    expect(decision.note).toContain('回落')
  })

  it('fails when no CLI is enabled', () => {
    const base = effectiveOf({})
    const cfg = config({
      claude: { ...base.claude, enabled: false },
      codex: { ...base.codex, enabled: false },
      grok: { ...base.grok, enabled: false },
    })
    expect(() => pickCli(cfg, 'auto', 'x')).toThrow(/没有已启用的 CLI/)
  })

  it('routes by task-type keywords', () => {
    const cfg = effectiveOf({})
    expect(pickCli(cfg, 'auto', '帮我重构这个模块').cli).toBe('claude')
    expect(pickCli(cfg, 'auto', '生成一个数据处理函数').cli).toBe('codex')
    expect(pickCli(cfg, 'auto', '帮我重构并补个项目测试').reason).toBe('keyword')
  })

  it.each([
    ['仓库探索', 'claude'], ['影响分析', 'claude'], ['模块重构', 'claude'],
    ['方案设计', 'claude'], ['文档整理', 'claude'], ['功能开发', 'codex'],
    ['缺陷修复', 'codex'], ['测试验证', 'codex'], ['代码审查', 'codex'], ['数据处理', 'codex'],
  ])('routes the new type %s to %s by default', (type, cli) => {
    const decision = pickCli(effectiveOf({}), 'auto', type)
    expect(decision.cli).toBe(cli)
    expect(decision.reason).toBe('keyword')
  })

  it('counts a legacy type and its current name only once', () => {
    const cfg = effectiveOf({ claudeTaskTypes: ['模块重构'], codexTaskTypes: [] })
    cfg.claude.taskTypes = ['重构', '模块重构']
    expect(keywordScore(cfg, 'claude', '重构和模块重构')).toBe(1)
    expect(keywordScore(cfg, 'claude', '重构')).toBe(1)
  })

  it('preserves case-insensitive custom task keywords', () => {
    const cfg = effectiveOf({ claudeTaskTypes: [], codexTaskTypes: ['Custom-Task'] })
    expect(pickCli(cfg, 'auto', 'run CUSTOM-TASK now').cli).toBe('codex')
    expect(pickCli(cfg, 'auto', 'run CUSTOM-TASK now').reason).toBe('keyword')
  })

  it('uses the default CLI when nothing matches', () => {
    const decision = pickCli(config(), 'auto', '做点别的事情')
    expect(decision.reason).toBe('default')
    expect(decision.cli).toBe(CONFIG_DEFAULTS.defaultCli)
  })

  it('prefers the non-disabled CLI when the default is disabled', () => {
    const cfg = config({ codex: { ...effectiveOf({}).codex, enabled: false } })
    expect(pickCli(cfg, 'auto', '无命中任务').cli).toBe('claude')
  })

  it('does not let independent thresholds affect explicit, keyword, default or tie routing', () => {
    const cfg = effectiveOf({ claudeMinTaskDifficulty: 'extreme', codexMinTaskDifficulty: 'low', defaultCli: 'claude' })
    expect(pickCli(cfg, 'claude', '项目测试').cli).toBe('claude')
    expect(pickCli(cfg, 'auto', '重构').cli).toBe('claude')
    expect(pickCli(cfg, 'auto', '项目测试').cli).toBe('codex')
    expect(pickCli(cfg, 'auto', '无命中').cli).toBe('claude')
    expect(pickCli(cfg, 'auto', '重构项目测试').cli).toBe('claude')
    cfg.defaultCli = 'codex'
    expect(pickCli(cfg, 'auto', '无命中').cli).toBe('codex')
    expect(pickCli(cfg, 'auto', '重构项目测试').cli).toBe('codex')
  })

  it('routes to an enabled grok by keywords and honors an explicit request', () => {
    const cfg = effectiveOf({ grokEnabled: true, grokTaskTypes: ['资料检索'] })
    expect(pickCli(cfg, 'grok', '随便').reason).toBe('requested')
    const decision = pickCli(cfg, 'auto', '帮我做一次资料检索')
    expect(decision.cli).toBe('grok')
    expect(decision.reason).toBe('keyword')
  })

  it('never scores a disabled grok and falls a grok request back to the default', () => {
    // grok defaults to disabled: a type only it owns cannot route while off.
    const cfg = effectiveOf({ grokTaskTypes: ['知识索引'] })
    expect(pickCli(cfg, 'auto', '帮我做一次知识索引').reason).toBe('default')
    const decision = pickCli(cfg, 'grok', 'x')
    expect(decision.cli).toBe('claude')
    expect(decision.note).toContain('grok 已停用')
    // The default wins the fallback when it is not the requested CLI.
    const grokDefault = effectiveOf({ grokEnabled: true, defaultCli: 'grok', claudeEnabled: false })
    expect(pickCli(grokDefault, 'claude', 'x').cli).toBe('grok')
  })

  it('prefers the default over a surprising hop when the requested CLI is disabled', () => {
    // default grok, claude+codex disabled: a codex request falls back to grok
    // (the default), not to claude just because it sorts first.
    const cfg = effectiveOf({ grokEnabled: true, defaultCli: 'grok', claudeEnabled: false, codexEnabled: false })
    expect(pickCli(cfg, 'codex', 'x').cli).toBe('grok')
  })
})

describe('task difficulty gate', () => {
  const reason = '任务涉及多个组件，需要按依赖顺序实现并验证回归风险'

  for (const cli of CLI_IDS) {
    for (const minimum of TASK_DIFFICULTIES) {
      for (const assessed of TASK_DIFFICULTIES) {
        it(`${cli}: ${assessed} ${TASK_DIFFICULTIES.indexOf(assessed) >= TASK_DIFFICULTIES.indexOf(minimum) ? 'passes' : 'fails'} the ${minimum} threshold`, () => {
          const cfg = effectiveOf({ claudeMinTaskDifficulty: 'low', codexMinTaskDifficulty: 'extreme' })
          cfg[cli].minTaskDifficulty = minimum
          const gate = () => assertTaskDifficulty(cfg, cli, assessed, reason)
          if (TASK_DIFFICULTIES.indexOf(assessed) >= TASK_DIFFICULTIES.indexOf(minimum)) {
            expect(gate()).toBe(assessed)
          } else {
            expect(gate).toThrow(RoutingError)
            expect(gate).toThrow(/低于最低难度/)
            expect(gate).toThrow(`实际 CLI：${cli}`)
            expect(gate).toThrow(`（${minimum}）`)
          }
        })
      }
    }
  }

  it('treats missing legacy assessments as low, never as keyword-derived high', () => {
    const cfg = effectiveOf({ claudeMinTaskDifficulty: 'low', codexMinTaskDifficulty: 'high' })
    expect(assertTaskDifficulty(cfg, 'claude', undefined, undefined)).toBe('low')
    expect(() => assertTaskDifficulty(cfg, 'codex', undefined, undefined)).toThrow(/未提供难度评估.*保守按低/)
  })

  it.each([
    ['HIGH', reason], ['unknown', reason], ['', reason], [3, reason], [null, reason],
    ['high', undefined], ['high', '   '], ['high', 3], ['high', null],
    [undefined, reason], ['high', 'x'.repeat(2_001)],
  ])('rejects invalid assessment %s / %s', (difficulty, rationale) => {
    expect(taskDifficultyError(difficulty, rationale)).toEqual(expect.any(String))
    expect(() => assertTaskDifficulty(config(), 'claude', difficulty, rationale)).toThrow(RoutingError)
  })

  it.each(CLI_IDS)('refuses an invalid %s minimum but ignores the other CLI minimum', cli => {
    const cfg = effectiveOf({ minTaskDifficulty: 'medium' })
    const other = cli === 'claude' ? 'codex' : 'claude'
    cfg[cli].minTaskDifficulty = 'unknown' as TaskDifficulty
    expect(() => assertTaskDifficulty(cfg, cli, 'high', reason)).toThrow(`${cli}.minTaskDifficulty 无效`)
    expect(assertTaskDifficulty(cfg, other, 'medium', reason)).toBe('medium')
  })
})

describe('routingHint', () => {
  it('shows current names even when a direct caller supplies legacy task types', () => {
    const cfg = effectiveOf({})
    cfg.claude.taskTypes = ['需求分析', '重构']
    cfg.codex.taskTypes = ['代码生成', '调试修复']
    const hint = routingHint(cfg, 'dispatch_cli_task')
    expect(hint).toContain('claude cli：擅长 方案设计、模块重构')
    expect(hint).toContain('codex cli：擅长 功能开发、缺陷修复')
    expect(hint).not.toContain('擅长 需求分析')
    expect(hint).not.toContain('擅长 代码生成')
  })

  it.each(TASK_DIFFICULTIES)('advertises each live %s threshold and the same assessment contract', minimum => {
    const hint = routingHint(effectiveOf({ minTaskDifficulty: minimum }), 'dispatch_cli_task')
    expect(hint).toContain(`最低任务难度：${TASK_DIFFICULTY_LABELS[minimum]}（${minimum}）`)
    expect(hint).toContain('各 CLI 分别配置')
    expect(hint).toContain('task_difficulty')
    expect(hint).toContain('difficulty_reason')
    expect(hint).toContain('等于门槛允许派发')
    expect(hint).toContain('简短问答')
    expect(hint).toContain('小范围编辑')
    expect(hint).toContain('跨模块重构')
    expect(hint).toContain('系统级复杂任务')
    expect(hint).toContain('先判断该任务是否需要开子代理')
    expect(hint).toContain('不需要就由主代理用现有工具自己完成')
    expect(hint).toContain('低于门槛改用 dsh 子代理')
    expect(hint).toContain('用户点名也不能绕过')
    expect(hint).toContain('创建任务或启动进程前')
    expect(hint).toContain('先确定真实 CLI')
    expect(hint).toContain('检查回落 CLI 的门槛')
    expect(hint).not.toContain('当任务整体适合')
    expect(hint).not.toContain('统一门槛')
    expect(hint).not.toContain('达到门槛后')
    expect(hint).not.toContain('仅用于门槛通过后')
  })

  it('changes each volatile minimum independently', () => {
    let claude = 'medium'
    let codex = 'high'
    const live = { claudeMinTaskDifficulty: { get: () => claude }, codexMinTaskDifficulty: { get: () => codex } } as unknown as Parameters<typeof effectiveOf>[0]
    const hint = () => routingHint(effectiveOf(live), 'dispatch_cli_task')
    expect(hint()).toMatch(/claude cli[^\n]*最低任务难度：中（medium）/)
    expect(hint()).toMatch(/codex cli[^\n]*最低任务难度：高（high）/)
    claude = 'extreme'
    expect(hint()).toMatch(/claude cli[^\n]*最低任务难度：极高（extreme）/)
    expect(hint()).toMatch(/codex cli[^\n]*最低任务难度：高（high）/)
    codex = 'low'
    expect(hint()).toMatch(/codex cli[^\n]*最低任务难度：低（low）/)
  })

  it('lists enabled CLIs with their task types and permissions', () => {
    const hint = routingHint(effectiveOf({ claudePermissionMode: 'acceptEdits' }), 'dispatch_cli_task')
    expect(hint).toContain('dispatch_cli_task')
    expect(hint).toContain('claude cli')
    expect(hint).toContain('acceptEdits')
    expect(hint).toContain('codex cli')
    expect(hint).toContain('重构')
  })

  it('is empty when the plugin is disabled', () => {
    expect(routingHint(config({ enabled: false }), 'dispatch_cli_task')).toBe('')
  })

  it('is empty when both CLIs are disabled', () => {
    const base = effectiveOf({})
    const cfg = config({ claude: { ...base.claude, enabled: false }, codex: { ...base.codex, enabled: false } })
    expect(routingHint(cfg, 'dispatch_cli_task')).toBe('')
  })
})

describe('built-in dsh fallback', () => {
  it('refuses to route a dsh-owned task type to either external CLI', () => {
    expect(() => pickCli(effectiveOf({}), 'auto', '帮我做代码定位')).toThrow(/dsh 子代理/)
    expect(() => pickCli(effectiveOf({}), 'auto', '整理资料检索结果')).toThrow(RoutingError)
  })

  it('lets a CLI win when it matches more task types than dsh', () => {
    const cfg = effectiveOf({ claudeTaskTypes: ['模块重构', '方案设计'], dshTaskTypes: ['模块重构'] })
    expect(pickCli(cfg, 'auto', '先做模块重构的方案设计').cli).toBe('claude')
  })

  it('only suggests dsh when the task also clears the dsh floor', () => {
    expect(() => assertTaskDifficulty(effectiveOf({}), 'claude', 'low', '小改动'))
      .toThrow(/达到内置 dsh 子代理门槛/)
    expect(() => assertTaskDifficulty(effectiveOf({ dshMinTaskDifficulty: 'high' }), 'claude', 'low', '小改动'))
      .toThrow(/也未达到内置 dsh 子代理门槛/)
  })

  it('advertises the dsh fallback and its live floor in the hint', () => {
    const hint = routingHint(effectiveOf({}), 'dispatch_cli_task')
    expect(hint).toContain('dsh 子代理（内置，默认回退）')
    expect(hint).toContain('最低任务难度：低（low）')
    expect(hint).toContain('无需安装')
    expect(routingHint(effectiveOf({ dshMinTaskDifficulty: 'extreme' }), 'dispatch_cli_task'))
      .toContain('最低任务难度：极高（extreme）')
  })
})
