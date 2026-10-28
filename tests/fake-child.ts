/**
 * A fake child process for channel/dispatch tests: an EventEmitter with the
 * surface runProcess touches (stdin/stdout/stderr streams, pid, kill, close).
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

export class FakeChild extends EventEmitter implements Partial<ChildProcess> {
  readonly stdin = new EventEmitter() as EventEmitter & { end(input?: string): void }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  stdinText: string | undefined
  readonly spawnArgs: string[]
  readonly spawnFile: string

  constructor(file: string, args: readonly string[]) {
    super()
    this.spawnFile = file
    this.spawnArgs = [...args]
    this.stdin.end = (input?: string) => {
      this.stdinText = input
      this.onStdin?.(input ?? '')
    }
  }

  onStdin: ((input: string) => void) | undefined

  /** Emit stdout data (a full multi-line chunk), then close with a code. */
  finish(stdout: string, code = 0, stderr = ''): void {
    queueMicrotask(() => {
      if (stdout !== '') this.stdout.emit('data', Buffer.from(stdout, 'utf8'))
      if (stderr !== '') this.stderr.emit('data', Buffer.from(stderr, 'utf8'))
      this.stdout.emit('end')
      this.exitCode = code
      this.emit('close', code, null)
    })
  }

  /** Simulate a kill: the process dies by signal. */
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true
    this.killSignal = signal ?? 'SIGTERM'
    queueMicrotask(() => {
      this.signalCode = this.killSignal
      this.emit('close', null, this.killSignal)
    })
    return true
  }

  private killSignal: NodeJS.Signals | null = null
}

export type ScriptedSpawn = (file: string, args: readonly string[]) => FakeChild

/** Build a spawnFn that routes by the argv shape and records every launch. */
export function scriptedSpawn(script: (child: FakeChild) => void): { spawnFn: ScriptedSpawn; launches: FakeChild[] } {
  const launches: FakeChild[] = []
  const spawnFn: ScriptedSpawn = (file, args) => {
    const child = new FakeChild(file, args)
    launches.push(child)
    script(child)
    return child as unknown as FakeChild
  }
  return { spawnFn, launches }
}
