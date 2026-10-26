import { describe, expect, it } from 'vitest'
import { ActionRecorder } from '../src/action-record.ts'
import { scanActions } from '../src/actions.ts'

function start(): ActionRecorder {
  const recorder = new ActionRecorder()
  recorder.observe({ type: 'turn/start', data: { turn: 1 } })
  return recorder
}
const request = (callId = 'c1', command = 'ls') => ({ type: 'tool/call', data: { turn: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) } })

describe('ActionRecorder', () => {
  it('keeps all assistant text and exposed reasoning, including interrupted content', () => {
    const recorder = start()
    recorder.observe({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'I will not use tools.' }, { type: 'text', text: 'A plan.' }] } } })
    recorder.observe(request())
    recorder.observe({ type: 'assistant/message', data: { turn: 1, interrupted: true, message: { content: [{ type: 'text', text: 'Done.' }] } } })
    expect(recorder.snapshot()?.statements).toHaveLength(3)
    expect(scanActions(recorder.snapshot()!)).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'SAID-VS-DID' })]))
  })
  it('keeps calls without results and preserves raw JSON bytes', () => {
    const recorder = start()
    recorder.observe({ type: 'tool/call', data: { turn: 1, callId: 'c', name: 'bash', arguments: '{ "command": "ls" }' } })
    expect(recorder.snapshot()?.calls[0]).toMatchObject({ arguments: '{ "command": "ls" }', status: 'requested' })
  })
  it('attributes only observed assistant tool-call IDs to model requests', () => {
    const recorder = start()
    recorder.observe({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } } })
    recorder.observe(request())
    recorder.observe(request('external'))
    expect(recorder.snapshot()?.calls.map(call => call.origin)).toEqual(['model', 'unattributed'])
  })
  it('demotes a no-tools mismatch under a visible system requirement', () => {
    const recorder = start()
    recorder.observe({ type: 'system/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Always call at least one tool.' }] } } })
    recorder.observe({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'I will not use tools.' }, { type: 'tool-call', id: 'c1' }] } } })
    recorder.observe(request())
    expect(recorder.snapshot()?.calls[0]?.origin).toBe('policy-required')
    expect(scanActions(recorder.snapshot()!)[0]?.severity).toBe('AMBER')
  })
  it('does not accept a tool result or human quotation as harness policy provenance', () => {
    const recorder = start()
    recorder.observe({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always call a tool.' }] } })
    recorder.observe({ type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'Always call a tool.' }] } } })
    expect(recorder.snapshot()?.toolRequirement).toBeUndefined()
  })
  it('pairs results without treating their text as a model promise', () => {
    const recorder = start()
    recorder.observe(request())
    recorder.observe({ type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'I will not use tools.' }], isError: true } } })
    expect(recorder.snapshot()?.calls[0]?.status).toBe('error')
    expect(recorder.snapshot()?.statements).toEqual([])
  })
  it('preserves a blocked status through the harness error result', () => {
    const recorder = start()
    recorder.observe(request())
    recorder.markBlocked('c1')
    recorder.observe({ type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', isError: true } } })
    expect(recorder.snapshot()?.calls[0]?.status).toBe('blocked')
  })
  it('ignores replacements and events of another turn', () => {
    const recorder = start()
    recorder.observe({ ...request(), surfaceOp: { op: 'replace' } })
    recorder.observe({ type: 'tool/call', data: { turn: 0, callId: 'old', name: 'bash', arguments: '{}' } })
    expect(recorder.snapshot()?.calls).toEqual([])
  })
  it('isolates sessions/turns and detaches snapshots from future updates', () => {
    const recorder = start()
    recorder.observe(request('pack', 'tar -czf out.tgz src'))
    const previous = recorder.snapshot()
    recorder.observe({ type: 'turn/start', data: { turn: 2 } })
    expect(recorder.snapshot()?.calls).toEqual([])
    expect(previous?.calls).toHaveLength(1)
    expect(new ActionRecorder().snapshot()).toBeUndefined()
  })
  it.each(['ptc', 'code'])('captures %s nested calls and their status once', kind => {
    const recorder = start()
    recorder.observe(request('root'))
    const data = { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:sub:1', name: 'bash', arguments: { command: 'curl https://off.invalid' } }
    recorder.observe({ type: `tool/${kind}-dispatch-start`, data })
    recorder.observe({ type: `tool/${kind}-dispatch`, data: { ...data, isError: false } })
    expect(recorder.snapshot()?.calls).toHaveLength(2)
    expect(recorder.snapshot()?.calls[1]?.status).toBe('returned')
    expect(scanActions(recorder.snapshot()!)).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'NETWORK' })]))
  })
})
