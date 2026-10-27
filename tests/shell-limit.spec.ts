import { describe, expect, it } from 'vitest'
import { shellCommands } from '../src/actions-shell.ts'

describe('shell inspection boundary', () => {
  it('still reads ordinary commands at the supported depth', () => {
    expect(shellCommands('echo drawing', 4).map(command => command.program)).toEqual(['echo'])
  })
  it('reports an incomplete inspection beyond the supported depth', () => {
    expect(() => shellCommands('echo drawing', 5)).toThrow('shell nesting exceeds inspection limit')
  })
})
