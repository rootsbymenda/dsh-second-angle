import { describe, expect, it } from 'vitest'
import { TurnRecorder, type RecordedEvent } from '../src/turn-record.ts'

const text = (value: string) => [{ type: 'text', text: value }]

function ev(type: string, data: Record<string, unknown>, surfaceOp?: RecordedEvent['surfaceOp']): RecordedEvent {
  return surfaceOp === undefined ? { type, data } : { type, data, surfaceOp }
}

describe('TurnRecorder', () => {
  it('rebuilds the tools, their outputs, and the last assistant text of the current turn', () => {
    const recorder = new TurnRecorder()
    recorder.observe(ev('turn/start', { turn: 3 }))
    recorder.observe(ev('assistant/message', { turn: 3, step: 0, message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } }))
    recorder.observe(ev('tool/call', { turn: 3, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }))
    recorder.observe(ev('tool/result', { turn: 3, step: 0, message: { toolCallId: 'c1', content: text('a\nb'), isError: false } }, 'append'))
    recorder.observe(ev('assistant/message', { turn: 3, step: 1, message: { content: text('There are 2 files.') } }))
    const record = recorder.snapshot(3)
    expect(record?.tools).toEqual([{ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}', output: 'a\nb', isError: false }])
    expect(record?.finalText).toBe('There are 2 files.')
    expect(record?.assistantMessages).toBe(2)
    expect(record?.closed).toBe(false)
  })

  it('ignores events of another turn and compaction replacements of older results', () => {
    const recorder = new TurnRecorder()
    recorder.observe(ev('turn/start', { turn: 1 }))
    recorder.observe(ev('tool/result', { turn: 0, step: 0, message: { toolCallId: 'old', content: text('old'), isError: false } }, 'append'))
    recorder.observe(ev('tool/result', { turn: 1, step: 0, message: { toolCallId: 'x', content: text('pruned'), isError: false } }, { op: 'replace' }))
    expect(recorder.snapshot(1)?.tools).toEqual([])
  })

  it('records an unknown tool name when the call event was not seen, and the error flag', () => {
    const recorder = new TurnRecorder()
    recorder.observe(ev('turn/start', { turn: 1 }))
    recorder.observe(ev('tool/result', { turn: 1, step: 0, message: { toolCallId: 'c9', content: text('boom'), isError: true } }, 'append'))
    expect(recorder.snapshot(1)?.tools[0]).toMatchObject({ name: 'unknown', isError: true, output: 'boom' })
  })

  it('keeps the LAST assistant message as the final text, empty when it carried no text', () => {
    const recorder = new TurnRecorder()
    recorder.observe(ev('turn/start', { turn: 1 }))
    recorder.observe(ev('assistant/message', { turn: 1, step: 0, message: { content: text('interim') } }))
    recorder.observe(ev('assistant/message', { turn: 1, step: 1, message: { content: [] }, interrupted: true }))
    expect(recorder.snapshot(1)).toMatchObject({ finalText: '', finalInterrupted: true })
  })

  it('reports no record for a turn whose start it did not see, and tracks closing', () => {
    const recorder = new TurnRecorder()
    expect(recorder.snapshot(1)).toBeUndefined()
    expect(recorder.isClosed(1)).toBe(true)
    recorder.observe(ev('turn/start', { turn: 1 }))
    expect(recorder.isClosed(1)).toBe(false)
    recorder.observe(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(recorder.isClosed(1)).toBe(true)
    expect(recorder.snapshot(1)?.closed).toBe(true)
    recorder.observe(ev('turn/start', { turn: 2 }))
    expect(recorder.snapshot(1)).toBeUndefined()
    expect(recorder.isClosed(1)).toBe(true)
    expect(recorder.isClosed(2)).toBe(false)
  })
})
