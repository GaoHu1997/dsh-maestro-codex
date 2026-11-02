import { describe, expect, it, vi } from 'vitest'
import { effectiveOf } from '../src/config.js'
import { BridgeState, createBridgeHandle } from '../src/bridge.js'

// The tool, agent, secret and port are all synthetic; no live HTTP or host call.
const secret = 'SYNTHETIC_BRIDGE_EXCEPTION_SECRET'
const publicToolFailure = '合成工具失败正文：上游配额不足'
function fixture(failure: 'throw' | 'error-outcome' | 'skill' | 'discovery') {
  const state = new BridgeState()
  let schemaCalls = 0
  const warn = vi.fn()
  const config = effectiveOf({ bridgeSkills: true, bridgeTools: 'custom', bridgeToolAllowlist: ['read'] })
  const bridge = createBridgeHandle({
    state,
    skills: () => ({ list: async () => [{ name: 'test-skill', description: 'synthetic' }], get: async () => { throw new Error(`Bearer ${secret}`) } }),
    tools: () => ({
      schemas: () => { schemaCalls += 1; if (failure === 'discovery' && schemaCalls > 1) throw new Error(secret); return [{ name: 'read' }] },
      execute: async () => {
        if (failure === 'throw') throw new Error(`arbitrary unlabelled ${secret}`)
        return { isError: true, error: { message: publicToolFailure }, content: [{ type: 'text', text: publicToolFailure }] }
      },
    }),
    readConfig: () => config,
    portOf: () => 12345,
    logger: { warn },
  })
  const run = bridge.runServerEntry(undefined, { agent: { id: 'synthetic-agent' } as never })
  if (run === undefined) throw new Error('synthetic bridge should be active')
  return { state, bridge, run, warn }
}

describe('bridge failure output boundary', () => {
  it('does not forward arbitrary credentials in a thrown host exception', async () => {
    const { bridge, run } = fixture('throw')
    try {
      const result = await bridge.callTool(run.token, 'read', {})
      expect(result).toMatchObject({ ok: false, status: 500 })
      expect(JSON.stringify(result)).not.toContain(secret)
      if (!result.ok) expect(result.error).toContain('read')
    } finally { bridge.revoke(run.token) }
  })

  it('retains an intentional structured tool failure body without projecting success', async () => {
    const { bridge, run } = fixture('error-outcome')
    try {
      expect(await bridge.callTool(run.token, 'read', {})).toEqual({ ok: false, status: 502, error: publicToolFailure })
    } finally { bridge.revoke(run.token) }
  })

  it('does not forward arbitrary skill loader exception text', async () => {
    const { bridge, run } = fixture('skill')
    try {
      const result = await bridge.loadSkill(run.token, 'test-skill', undefined)
      expect(result).toMatchObject({ ok: false, status: 500 })
      expect(JSON.stringify(result)).not.toContain(secret)
    } finally { bridge.revoke(run.token) }
  })

  it('does not send tool discovery exceptions to the server logger', async () => {
    const { bridge, run, warn } = fixture('discovery')
    try {
      await bridge.catalog(run.token)
      expect(warn).toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    } finally { bridge.revoke(run.token) }
  })
})
