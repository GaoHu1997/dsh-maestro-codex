import { describe, expect, it } from 'vitest'
import { effectiveOf } from '../src/config.js'
import { CLI_IDS, pickCli } from '../src/routing.js'
import { handleModels, type RouteDeps } from '../src/routes.js'

const dshTasks = ['帮我做代码定位', '整理资料检索结果', '进行方案核验']

function modelsDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    listDshModels: async () => ({ providers: [] }),
    listMcpServers: () => [],
    ...overrides,
  } as RouteDeps
}

const secret = 'SYNTHETIC_PRE_RELEASE_SECRET'
const privateDetail = `Bearer ${secret} at https://user:PRIVATE_PASSWORD@provider.invalid/?key=PRIVATE_QUERY; D:/private/credentials.json`
const failures: Array<{ label: string; value: unknown }> = [
  { label: 'Error', value: new Error(privateDetail) },
  { label: 'string', value: privateDetail },
  { label: 'object', value: { apiKey: secret, internalPath: 'D:/private/credentials.json' } },
]

function expectSanitized(outcome: Awaited<ReturnType<typeof handleModels>>): void {
  expect(outcome.status).toBe(500)
  expect(outcome.body).toEqual({ error: '模型目录暂不可用，请检查宿主模型与 MCP 服务配置' })
  expect(JSON.stringify(outcome.body)).not.toMatch(/SYNTHETIC_PRE_RELEASE_SECRET|PRIVATE_PASSWORD|PRIVATE_QUERY|D:\/private/)
}

describe('pre-release DSH routing boundary', () => {
  for (const cli of CLI_IDS) {
    it.each(dshTasks)(`refuses explicit ${cli} for a DSH-owned task: %s`, task => {
      expect(() => pickCli(effectiveOf({ grokEnabled: true }), cli, task)).toThrow(/任务类型命中 dsh 子代理/)
    })
  }

  for (const requested of ['auto', ...CLI_IDS]) {
    it.each(dshTasks)(`keeps DSH available with every external CLI disabled (${requested}): %s`, task => {
      const config = effectiveOf({ claudeEnabled: false, codexEnabled: false, grokEnabled: false })
      expect(() => pickCli(config, requested, task)).toThrow(/任务类型命中 dsh 子代理/)
    })
  }

  it('does not replace an invalid CLI diagnostic with a DSH routing suggestion', () => {
    expect(() => pickCli(effectiveOf({}), 'gemini', dshTasks[0]!)).toThrow(/未知 CLI/)
  })

  it('preserves the CLI tie rule for a stale shared task type', () => {
    const config = effectiveOf({ claudeTaskTypes: ['代码定位'], dshTaskTypes: ['代码定位'] })
    expect(pickCli(config, 'auto', dshTasks[0]!).cli).toBe('claude')
    expect(pickCli(config, 'claude', dshTasks[0]!).cli).toBe('claude')
  })

  it('still refuses a non-DSH task when every external CLI is disabled', () => {
    const config = effectiveOf({ claudeEnabled: false, codexEnabled: false, grokEnabled: false })
    expect(() => pickCli(config, 'auto', '其他任务')).toThrow(/没有已启用的 CLI/)
  })
})

describe('pre-release public models diagnostics', () => {
  it.each(failures)('does not echo a rejected model catalog ($label)', async ({ value }) => {
    expectSanitized(await handleModels(modelsDeps({ listDshModels: async () => { throw value } })))
  })

  it('does not echo MCP server discovery failures', async () => {
    expectSanitized(await handleModels(modelsDeps({ listMcpServers: () => { throw new Error(privateDetail) } })))
  })

  it('does not echo bridge diagnostics failures', async () => {
    const bridge = { diagnose: async () => { throw new Error(privateDetail) } } as NonNullable<RouteDeps['bridge']>
    expectSanitized(await handleModels(modelsDeps({ bridge })))
  })

  it.each(failures)('keeps describe failures useful but sanitized ($label)', async ({ value }) => {
    const result = await handleModels(modelsDeps({
      mcpDiagnosticsEnabled: () => true,
      describeSettings: () => { throw value },
    }))
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ providers: [], mcpServers: [], mcpDiagnostics: ['describe failed: 宿主设置描述不可用'] })
  })

  it('preserves successful model and MCP catalog responses without leaking settings values', async () => {
    const providers = [{ id: 'synthetic', displayName: 'Synthetic', api: 'openai-responses', mappable: true, models: [] }]
    const result = await handleModels(modelsDeps({
      listDshModels: async () => ({ providers }),
      listMcpServers: () => [{ name: 'synthetic-server', transport: 'stdio', command: 'synthetic', args: [], env: {}, source: 'synthetic' }],
      mcpDiagnosticsEnabled: () => true,
      describeSettings: () => [{ ns: 'synthetic', value: { apiKey: secret } }],
    }))
    expect(result.body).toEqual({ providers, mcpServers: [{ name: 'synthetic-server', source: 'synthetic' }], mcpDiagnostics: ['synthetic: apiKey'] })
    expect(JSON.stringify(result.body)).not.toContain(secret)
  })
})
