// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, StrictMode, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useActiveCliAccess, useCliAccess } from '../src/client/access.js'
import type { BoardSessionList } from '../src/client/board/data.js'
import type { MaestroSessionAccess } from '../src/wire.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: Root[] = []
const hosts: HTMLDivElement[] = []
function fixture(owner: string, tokenChar: string): BoardSessionList {
  return { byId: {}, projectionsBySession: { [owner]: { values: { maestroCliAccess: { sessionId: owner, token: tokenChar.repeat(64) } } } } } as BoardSessionList
}
function Publisher(props: { owner: string; tokenChar: string; visible: boolean }): ReactNode {
  useCliAccess(fixture(props.owner, props.tokenChar), props.owner, props.visible)
  return null
}
function StablePublisher(props: { list: BoardSessionList; owner: string | undefined; visible?: boolean }): ReactNode {
  useCliAccess(props.list, props.owner, props.visible)
  return null
}
function Reader(props: { observe?: (access: MaestroSessionAccess | undefined) => void }): ReactNode {
  const access = useActiveCliAccess()
  useLayoutEffect(() => { props.observe?.(access) }, [access, props.observe])
  // Credentials are never rendered: only the selected fixture owner is observable.
  return <span data-testid="selected">{access?.sessionId ?? 'NONE'}</span>
}
function mount(): { host: HTMLDivElement; render(node: ReactNode): void; unmount(): void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  hosts.push(host)
  return {
    host,
    render(node) { act(() => root.render(node)) },
    unmount() {
      const index = roots.indexOf(root)
      if (index < 0) return
      roots.splice(index, 1)
      act(() => root.unmount())
    },
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const host of hosts.splice(0)) host.remove()
})
describe('only active host-selected entries publish the resource-tab principal', () => {
  it('a hidden A board cannot override active B on mount or token rotation', () => {
    const f = mount()
    const render = (char: string) => f.render(<><Publisher owner="B" tokenChar="b" visible /><Publisher owner="A" tokenChar={char} visible={false} /><Reader /></>)
    render('a')
    expect(f.host.textContent).toBe('B')
    render('c')
    expect(f.host.textContent).toBe('B')
  })
  it('unmounting a hidden entry cannot clear the current B principal', () => {
    const f = mount()
    f.render(<><Publisher key="B" owner="B" tokenChar="b" visible /><Publisher key="A" owner="A" tokenChar="a" visible={false} /><Reader key="reader" /></>)
    f.render(<><Publisher key="B" owner="B" tokenChar="b" visible /><Reader key="reader" /></>)
    expect(f.host.textContent).toBe('B')
  })
  it('a newly selected parent without a valid credential invalidates old B access', () => {
    const f = mount()
    f.render(<><Publisher owner="B" tokenChar="b" visible /><Reader /></>)
    expect(f.host.textContent).toBe('B')
    f.render(<><Publisher owner="C" tokenChar="invalid" visible /><Reader /></>)
    expect(f.host.textContent).toBe('NONE')
  })
})

describe('independent publishers share only the current host-selected credential', () => {
  it.each([
    ['header', 'hide'], ['header', 'unmount'], ['board', 'hide'], ['board', 'unmount'],
  ] as const)('keeps a stable shared credential when %s disappears via %s', (removed, mode) => {
    const shared = fixture('A', 'a')
    const f = mount()
    const render = (remove: boolean) => f.render(<>
      {!(remove && removed === 'header' && mode === 'unmount') && <StablePublisher key="header" list={shared} owner="A" visible={!(remove && removed === 'header')} />}
      {!(remove && removed === 'board' && mode === 'unmount') && <StablePublisher key="board" list={shared} owner="A" visible={!(remove && removed === 'board')} />}
      <Reader key="reader" />
    </>)
    render(false)
    expect(f.host.textContent).toBe('A')
    render(true)
    expect(f.host.textContent).toBe('A')
    f.render(<Reader key="reader" />)
    expect(f.host.textContent).toBe('NONE')
  })

  it('shares ownership across independent roots and clears after the last root unmounts', () => {
    const shared = fixture('A', 'a')
    const header = mount()
    const board = mount()
    const reader = mount()
    reader.render(<Reader />)
    header.render(<StablePublisher list={shared} owner="A" />)
    board.render(<StablePublisher list={shared} owner="A" />)
    expect(reader.host.textContent).toBe('A')
    header.unmount()
    expect(reader.host.textContent).toBe('A')
    board.unmount()
    expect(reader.host.textContent).toBe('NONE')
  })

  it.each([
    { label: 'missing projection', list: { byId: {} } as BoardSessionList },
    { label: 'null projection', list: { byId: {}, projectionsBySession: { A: { values: { maestroCliAccess: null } } } } as BoardSessionList },
    { label: 'invalid token', list: fixture('A', 'invalid') },
  ])('clears a sole publisher on $label and can receive a fresh valid projection', ({ list }) => {
    const f = mount()
    const render = (projection: BoardSessionList, visible = true) => f.render(<>
      <StablePublisher key="publisher" list={projection} owner="A" visible={visible} />
      <Reader key="reader" />
    </>)
    render(fixture('A', 'a'))
    expect(f.host.textContent).toBe('A')
    render(list)
    expect(f.host.textContent).toBe('NONE')
    const refreshed = fixture('A', 'b')
    render(refreshed)
    expect(f.host.textContent).toBe('A')
    render(refreshed, false)
    expect(f.host.textContent).toBe('NONE')
  })

  it('preserves snapshot identity for equivalent credentials from independent objects', () => {
    const first = fixture('A', 'a')
    const second = fixture('A', 'a')
    const snapshots: (MaestroSessionAccess | undefined)[] = []
    const observe = (access: MaestroSessionAccess | undefined) => { snapshots.push(access) }
    const f = mount()
    const render = (includeFirst: boolean, list: BoardSessionList) => f.render(<>
      {includeFirst && <StablePublisher key="first" list={first} owner="A" />}
      <StablePublisher key="second" list={list} owner="A" />
      <Reader key="reader" observe={observe} />
    </>)
    render(true, second)
    const original = first.projectionsBySession?.A?.values.maestroCliAccess
    expect(snapshots.at(-1)).toBe(original)
    const committed = snapshots.length
    render(false, second)
    expect(f.host.textContent).toBe('A')
    expect(snapshots.at(-1)).toBe(original)
    render(false, fixture('A', 'a'))
    expect(snapshots.length).toBe(committed)
    const rotated = fixture('A', 'b')
    render(false, rotated)
    expect(snapshots.at(-1)).toBe(rotated.projectionsBySession?.A?.values.maestroCliAccess)
  })

  it('does not let stale A refreshes or removal of current B resurrect A', () => {
    const initialA = fixture('A', 'a')
    const currentB = fixture('B', 'b')
    const f = mount()
    const render = (header: BoardSessionList | undefined, stale: BoardSessionList, visible = true) => f.render(<>
      {header !== undefined && <StablePublisher key="header" list={header} owner={header === initialA ? 'A' : 'B'} />}
      <StablePublisher key="board" list={stale} owner="A" visible={visible} />
      <Reader key="reader" />
    </>)
    render(initialA, initialA)
    expect(f.host.textContent).toBe('A')
    render(currentB, initialA)
    expect(f.host.textContent).toBe('B')
    const refreshedA = fixture('A', 'c')
    render(currentB, refreshedA)
    expect(f.host.textContent).toBe('B')
    render(undefined, refreshedA)
    expect(f.host.textContent).toBe('NONE')
    const refreshedAgain = fixture('A', 'd')
    render(undefined, refreshedAgain)
    expect(f.host.textContent).toBe('NONE')
    // An explicit host visibility transition may select A again; projection churn may not.
    render(undefined, refreshedAgain, false)
    render(undefined, refreshedAgain, true)
    expect(f.host.textContent).toBe('A')
  })

  it.each([
    { label: 'missing projection', owner: 'C', list: { byId: {} } as BoardSessionList },
    { label: 'invalid token', owner: 'C', list: fixture('C', 'invalid') },
    { label: 'foreign owner', owner: 'C', list: { byId: {}, projectionsBySession: { C: { values: { maestroCliAccess: { sessionId: 'A', token: 'a'.repeat(64) } } } } } as BoardSessionList },
    { label: 'undefined host session', owner: undefined, list: fixture('A', 'a') },
  ])('invalidates old access for $label without falling back on cleanup', ({ owner, list }) => {
    const old = fixture('A', 'a')
    const f = mount()
    f.render(<><StablePublisher key="old" list={old} owner="A" /><Reader key="reader" /></>)
    expect(f.host.textContent).toBe('A')
    f.render(<><StablePublisher key="old" list={old} owner="A" /><StablePublisher key="new" list={list} owner={owner} /><Reader key="reader" /></>)
    expect(f.host.textContent).toBe('NONE')
    f.render(<><StablePublisher key="old" list={old} owner="A" /><Reader key="reader" /></>)
    expect(f.host.textContent).toBe('NONE')
    f.render(<><StablePublisher key="old" list={fixture('A', 'b')} owner="A" /><Reader key="reader" /></>)
    expect(f.host.textContent).toBe('NONE')
  })

  it.each(['rotate', 'revoke'] as const)('does not restore a superseded same-session credential after %s', mode => {
    const old = fixture('A', 'a')
    const changed = mode === 'rotate' ? fixture('A', 'b') : { byId: {} } as BoardSessionList
    const snapshots: (MaestroSessionAccess | undefined)[] = []
    const observe = (access: MaestroSessionAccess | undefined) => { snapshots.push(access) }
    const f = mount()
    const render = (current: BoardSessionList | undefined) => f.render(<>
      <StablePublisher key="old" list={old} owner="A" />
      {current !== undefined && <StablePublisher key="current" list={current} owner="A" />}
      <Reader key="reader" observe={observe} />
    </>)
    render(old)
    expect(f.host.textContent).toBe('A')
    render(changed)
    expect(snapshots.at(-1)).toBe(changed.projectionsBySession?.A?.values.maestroCliAccess)
    render(undefined)
    expect(f.host.textContent).toBe('NONE')
  })

  it('a non-publishing hook still receives local access and cannot replace the principal', () => {
    const passive = fixture('A', 'a')
    const current = fixture('B', 'b')
    function Passive(): ReactNode {
      const access = useCliAccess(passive, 'A', false)
      return <i>{access?.sessionId ?? 'NONE'}</i>
    }
    const f = mount()
    f.render(<><StablePublisher key="current" list={current} owner="B" /><Passive key="passive" /><Reader key="reader" /></>)
    expect(f.host.querySelector('i')?.textContent).toBe('A')
    expect(f.host.querySelector('[data-testid="selected"]')?.textContent).toBe('B')
    f.render(<><Passive key="passive" /><Reader key="reader" /></>)
    expect(f.host.querySelector('[data-testid="selected"]')?.textContent).toBe('NONE')
  })

  it('cleans up repeated StrictMode setup, hide, remount and session switches independently', () => {
    const a = fixture('A', 'a')
    const b = fixture('B', 'b')
    const f = mount()
    const render = (owner: string, list: BoardSessionList, header: boolean, board: boolean, visible = true) => f.render(<StrictMode>
      {header && <StablePublisher key="header" list={list} owner={owner} />}
      {board && <StablePublisher key="board" list={list} owner={owner} visible={visible} />}
      <Reader key="reader" />
    </StrictMode>)
    for (let repeat = 0; repeat < 2; repeat += 1) {
      render('A', a, true, true)
      expect(f.host.textContent).toBe('A')
      render('A', a, true, true, false)
      expect(f.host.textContent).toBe('A')
      render('A', a, true, false)
      expect(f.host.textContent).toBe('A')
      render('B', b, true, true)
      expect(f.host.textContent).toBe('B')
      render('B', b, false, true)
      expect(f.host.textContent).toBe('B')
      render('B', b, false, false)
      expect(f.host.textContent).toBe('NONE')
    }
  })
})
