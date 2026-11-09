import { describe, expect, it } from 'vitest'
import { main } from '../scripts/repair-cli-session-logs.mjs'

describe('repair CLI mutually exclusive safety modes', () => {
  it.each([
    ['--apply', '--dry-run'],
    ['--dry-run', '--apply'],
  ])('refuses conflicting modes %j before loading a runtime or opening a log', async (...argv) => {
    // Intentionally supply no paths: argument rejection must precede even
    // the required-path check, and can never touch a user or fixture session.
    await expect(main(argv)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  })
})
