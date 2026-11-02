import { describe, expect, it } from 'vitest'
import { isReservedCliRecordSession } from '../src/record-guard.js'

describe('stable full UUID CLI record namespace', () => {
  it('recognizes both new UUID and legacy short CLI ids without granting access', () => {
    for (const id of ['cli-task-01234567', 'cli-task-01234567-89ab-4cde-8fab-0123456789ab']) {
      expect(isReservedCliRecordSession({ id, header: { origin: 'subagent' } })).toBe(true)
      expect(isReservedCliRecordSession({ id, header: { origin: 'user' } })).toBe(false)
    }
  })
  it('does not reserve malformed or unrelated caller-selected names', () => {
    for (const id of ['cli-task-01234567-zzzz-4cde-8fab-0123456789ab', 'cli-custom-id', 'session-01234567-89ab-4cde-8fab-0123456789ab']) {
      expect(isReservedCliRecordSession({ id, header: { origin: 'subagent' } })).toBe(false)
    }
  })
})
