import type { EffectiveConfig } from '../src/config.js'
import { parseDshModelSelection, type DshModelEndpoint } from '../src/dsh-models.js'

/** Trusted, in-memory routes for dispatch tests. No endpoint is ever contacted. */
export function withTestDshRoutes(config: EffectiveConfig): EffectiveConfig {
  return {
    ...config,
    claude: { ...config.claude, dshModel: config.claude.dshModel || 'test-claude::test-claude-model' },
    codex: { ...config.codex, dshModel: config.codex.dshModel || 'test-codex::test-codex-model' },
    grok: { ...config.grok, dshModel: config.grok.dshModel || 'test-grok::test-grok-model' },
  }
}

export async function resolveTestDshModel(selection: string): Promise<DshModelEndpoint> {
  const route = parseDshModelSelection(selection)
  if (route === undefined || !['test-claude', 'test-codex', 'test-grok'].includes(route.provider)) {
    throw new Error(`Unknown test-only DSH route: ${selection}`)
  }
  return {
    ...route,
    api: route.provider === 'test-codex' ? 'openai-responses' : route.provider === 'test-grok' ? 'openai-completions' : 'anthropic-messages',
    baseURL: `https://${route.provider}.invalid/v1`,
    apiKey: 'test-only-not-a-real-key',
  }
}
