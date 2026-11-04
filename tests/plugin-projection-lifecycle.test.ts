import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { CLI_ACCESS_PROJECTION_KEY } from '../src/wire.js'
import { installCliUsageProjection, projectionRegistryOf } from '../src/usage.js'

const safety = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('node:child_process', () => {
 const reject = (name: string) => (..._args: unknown[]) => { safety.calls.push(name); throw new Error(`Forbidden external process in projection lifecycle regression: ${name}`) }
 return { spawn: reject('spawn'), execFile: reject('execFile'), exec: reject('exec'), spawnSync: reject('spawnSync'), execSync: reject('execSync'), execFileSync: reject('execFileSync') }
})
const roots: Context[] = []
let home: string
beforeEach(async () => {
 safety.calls.length = 0
 home = await mkdtemp(join(tmpdir(), 'maestro-projection-lifecycle-'))
 vi.stubEnv('DSH_HOME', home)
 vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden in projection lifecycle regression') }))
 vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(async () => {
 for (const root of roots.splice(0)) await root.fiber.dispose()
 expect(safety.calls).toEqual([])
 vi.restoreAllMocks()
 vi.unstubAllGlobals()
 vi.unstubAllEnvs()
 await rm(home, { recursive: true, force: true })
})
interface Definition {
 key: string
 init(header: unknown, count: number): unknown
 wire?: { view(state: unknown): unknown }
}
type Inject = (dependencies: readonly string[], callback: (inner: Context) => void) => unknown
async function start(mode: 'healthy' | 'getter' | 'register-getter' | 'access-partial' | 'disposer') {
 const root = new Context()
 roots.push(root)
 const registered: Definition[] = []
 const disposed: string[] = []
 let reads = 0
 const service = {
  stateOf: () => undefined,
  register(definition: Definition) {
   expect(this).toBe(service)
   registered.push(definition)
   if (mode === 'access-partial' && definition.key === CLI_ACCESS_PROJECTION_KEY) {
    definition.wire?.view(definition.init({ id: 'partial-scope' }, 0))
    throw new Error('Controlled partially registered access projection')
   }
   return () => { disposed.push(definition.key); if (mode === 'disposer') throw new Error('Controlled host disposer rejection') }
  },
 }
 if (mode === 'register-getter') Object.defineProperty(service, 'register', { get() { throw new Error('Controlled register getter rejection') } })
 const fiber = root.plugin({
  name: 'maestro-composition-regression',
  apply(ctx: Context) {
   const inject = ctx.inject.bind(ctx) as unknown as Inject
   Object.defineProperty(ctx, 'inject', { configurable: true, value: (dependencies: readonly string[], callback: (inner: Context) => void) => {
    if (!dependencies.includes('sessionProjections')) return inject(dependencies, callback)
    const host = new Proxy(ctx, { get(target, key, receiver) {
     if (key === 'sessionProjections') { reads++; if (mode === 'getter') throw new Error('Controlled projection getter rejection'); return service }
     return Reflect.get(target, key, receiver)
    } })
    return callback(host)
   } })
   apply(ctx, { enabled: false, injectGitContext: false })
  },
 })
 await fiber.await()
 await vi.waitFor(() => expect(existsSync(join(home, 'maestro', 'config-history.json'))).toBe(true), { timeout: 4000, interval: 25 })
 return { fiber, registered, disposed, reads }
}

describe('complete plugin optional projection lifecycle in a real Cordis fiber (simulated host seam)', () => {
 it.each(['getter', 'register-getter'] as const)('keeps the plugin active when %s rejects access', async mode => {
  const result = await start(mode)
  expect(result.fiber.state).toBe(2)
  expect(result.reads).toBe(1)
  expect(result.registered).toEqual([])
  await expect(result.fiber.dispose()).resolves.toBeUndefined()
 })
 it('isolates access registration failure and still installs and cleans the other projections', async () => {
  const result = await start('access-partial')
  expect(result.fiber.state).toBe(2)
  expect(result.registered).toHaveLength(3)
  const access = result.registered.find(definition => definition.key === CLI_ACCESS_PROJECTION_KEY)!
  expect(access.wire!.view(access.init({ id: 'partial-scope' }, 0))).toBeNull()
  await result.fiber.dispose()
  expect(result.disposed).toHaveLength(2)
  expect(result.disposed).not.toContain(CLI_ACCESS_PROJECTION_KEY)
 })
 it('attempts every cleanup even if the host disposers throw', async () => {
  const result = await start('disposer')
  expect(result.reads).toBe(1)
  expect(result.registered).toHaveLength(3)
  await expect(result.fiber.dispose()).resolves.toBeUndefined()
  expect(result.disposed).toHaveLength(3)
  expect(new Set(result.disposed).size).toBe(3)
  await result.fiber.dispose()
  expect(result.disposed).toHaveLength(3)
 })
 it('uses one captured service face and retains its register receiver', async () => {
  const result = await start('healthy')
  expect(result.reads).toBe(1)
  expect(result.registered).toHaveLength(3)
  await result.fiber.dispose()
  expect(result.disposed).toHaveLength(3)
 })
})

describe('usage projection getter boundary', () => {
 it('contains a refusing register getter without reporting installation success', () => {
  const service = Object.defineProperty({}, 'register', { get() { throw new Error('Controlled usage register getter') } })
  expect(projectionRegistryOf({ sessionProjections: service })).toBeUndefined()
  expect(installCliUsageProjection({ sessionProjections: service })).toBeUndefined()
 })
 it('captures register once with the original service receiver', () => {
  let reads = 0, disposed = 0
  const service = Object.defineProperty({}, 'register', { get() { reads++; return function(this: unknown) { expect(this).toBe(service); return () => { disposed++ } } } })
  const dispose = installCliUsageProjection({ sessionProjections: service })
  expect(reads).toBe(1)
  dispose?.()
  expect(disposed).toBe(1)
 })
})
