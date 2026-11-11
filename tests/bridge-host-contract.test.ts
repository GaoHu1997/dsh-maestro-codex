/**
 * The host-tool settlement contract, pinned.
 *
 * `ctx.tools.execute` is a BATCH executor: it forwards its input straight to
 * `executeToolBatch`, which destructures `input.calls` and answers
 * `{ results: [{ callId, result }] }`. The bridge once passed a lone
 * `{ callId, name, arguments }`, so `calls` was undefined and the registry threw
 * before any tool body ran — every bridged call failed with an opaque 500 while
 * the in-process fakes (which answered a bare result) kept the suite green.
 *
 * These tests assert the outgoing shape, not just the projected text, and they
 * fail loudly if the bridge regresses to a lone call.
 */

import { describe, expect, it, vi } from 'vitest'
import { effectiveOf } from '../src/config.js'
import { BridgeState, createBridgeHandle, hostToolOutcomeOf, type HostToolBatch, type ToolsFace } from '../src/bridge.js'

const WEB_TOOL = {
  name: 'web_search',
  description: '搜索',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
}

function bridgeWith(execute: ToolsFace['execute']): {
  call: (args?: Record<string, unknown>) => ReturnType<ReturnType<typeof createBridgeHandle>['callTool']>
  warn: ReturnType<typeof vi.fn>
  state: BridgeState
  diagnose: () => ReturnType<ReturnType<typeof createBridgeHandle>['diagnose']>
} {
  const warn = vi.fn()
  const state = new BridgeState()
  const face: ToolsFace = { schemas: () => [WEB_TOOL], execute }
  const bridge = createBridgeHandle({
    skills: () => undefined,
    tools: () => face,
    portOf: () => 8765,
    readConfig: () => effectiveOf({ bridgeSkills: false, bridgeTools: 'auto', bridgeToolAllowlist: [] }),
    state,
    logger: { warn },
  })
  const run = bridge.runServerEntry(undefined, { agent: { id: 'contract-host' } as never })
  if (run === undefined) throw new Error('bridge did not mount')
  return {
    call: (args = { query: 'dsh' }) => bridge.callTool(run.token, 'web_search', args),
    warn,
    state,
    diagnose: () => bridge.diagnose(),
  }
}

describe('host tool settlement contract', () => {
  it('sends a one-element batch and projects the settled result', async () => {
    const seen: HostToolBatch[] = []
    const fixture = bridgeWith(async batch => {
      seen.push(batch)
      return {
        results: batch.calls.map(call => ({
          callId: call.id,
          result: { content: [{ type: 'text', text: `结果：${String(call.arguments['query'])}` }], isError: false },
        })),
        additionalContexts: [],
        concluded: false,
      }
    })

    await expect(fixture.call()).resolves.toMatchObject({ ok: true, text: '结果：dsh' })

    expect(seen).toHaveLength(1)
    const batch = seen[0]!
    // The outgoing shape is the contract: a lone call object has no `calls`.
    expect(batch.calls).toHaveLength(1)
    expect(batch.calls[0]).toMatchObject({ name: 'web_search', arguments: { query: 'dsh' } })
    expect(typeof batch.calls[0]!.id).toBe('string')
    expect(batch.signal).toBeInstanceOf(AbortSignal)
    expect(batch.agent).toBeDefined()
    expect(fixture.state.lastHostToolContract).toBe('batch')
    await expect(fixture.diagnose()).resolves.toMatchObject({ hostToolContract: 'batch' })
  })

  it('still accepts a bare single result and records that shape', async () => {
    const fixture = bridgeWith(async () => ({
      content: [{ type: 'text', text: '单结果' }],
      isError: false,
    }))

    await expect(fixture.call()).resolves.toMatchObject({ ok: true, text: '单结果' })
    expect(fixture.state.lastHostToolContract).toBe('single')
  })

  it('turns an unrecognised settlement into a diagnostic 502 instead of an empty success', async () => {
    const fixture = bridgeWith(async () => ({ unexpected: true }))

    const outcome = await fixture.call()
    expect(outcome).toMatchObject({ ok: false, status: 502 })
    expect(outcome).toHaveProperty('error', expect.stringContaining('契约 unknown'))
    expect(fixture.state.lastHostToolContract).toBe('unknown')
    expect(fixture.warn).toHaveBeenCalledWith(expect.stringContaining('unrecognised settlement'))
  })

  it('summarises a generic exception for the child and keeps the full text in the log', async () => {
    const fixture = bridgeWith(async () => { throw new TypeError('calls is not iterable') })

    const outcome = await fixture.call()
    expect(outcome).toMatchObject({ ok: false, status: 500 })
    // A bare TypeError message is untrusted text (it may embed a credential):
    // the child gets the type, the log gets the sentence.
    expect(outcome).toHaveProperty('error', expect.stringContaining('TypeError'))
    expect(outcome).toHaveProperty('error', expect.stringContaining('宿主日志'))
    expect(outcome).toHaveProperty('error', expect.not.stringContaining('calls is not iterable'))
    expect(outcome).toHaveProperty('error', expect.not.stringContaining('未向子代理公开'))
    expect(fixture.warn).toHaveBeenCalledWith(expect.stringContaining('calls is not iterable'))
  })

  it('forwards a classified tool error, which is the host tool’s own contract', async () => {
    class WebError extends Error { readonly code = 'WEB_PROVIDER_ERROR' }
    const fixture = bridgeWith(async () => {
      const error = new WebError('DeepSeek API error (HTTP 402): Insufficient Balance')
      error.name = 'WebError'
      throw error
    })

    const outcome = await fixture.call()
    expect(outcome).toMatchObject({ ok: false, status: 500 })
    expect(outcome).toHaveProperty('error', expect.stringContaining('Insufficient Balance'))
    expect(fixture.warn).toHaveBeenCalledWith(expect.stringContaining('Insufficient Balance'))
  })
})

describe('hostToolOutcomeOf', () => {
  it('matches the call id inside a batch and never falls back to another slot', () => {
    const settled = hostToolOutcomeOf({
      results: [
        { callId: 'a', result: { content: [{ type: 'text', text: 'A' }], isError: false } },
        { callId: 'b', result: { content: [{ type: 'text', text: 'B' }], isError: false } },
      ],
    }, 'b')
    expect(settled.contract).toBe('batch')
    expect(settled.result).toMatchObject({ content: [{ type: 'text', text: 'B' }] })
  })

  it('reports a missing call id as an empty batch slot, not an unknown shape', () => {
    expect(hostToolOutcomeOf({ results: [] }, 'missing')).toEqual({ contract: 'batch', result: undefined })
  })

  it('refuses null, primitives and unrelated objects', () => {
    expect(hostToolOutcomeOf(undefined, 'x').contract).toBe('unknown')
    expect(hostToolOutcomeOf('text', 'x').contract).toBe('unknown')
    expect(hostToolOutcomeOf({ content: [] }, 'x').contract).toBe('single')
    expect(hostToolOutcomeOf({ isError: true }, 'x').contract).toBe('single')
    expect(hostToolOutcomeOf({}, 'x').contract).toBe('unknown')
  })
})
