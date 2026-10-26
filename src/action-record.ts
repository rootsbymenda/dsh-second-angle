/** ACTIONS uses requests, including denied/missing-result calls, independently of claim evidence. */
import type { ActionCall, ActionStatement, ActionTurn } from './actions.ts'
import type { RecordedEvent } from './turn-record.ts'

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export class ActionRecorder {
  private turn: number | undefined
  private order = 0
  private calls = new Map<string, ActionCall>()
  private statements: ActionStatement[] = []
  private modelCalls = new Set<string>()
  private toolRequirement: string | undefined

  private observeRequirement(event: RecordedEvent, data: Record<string, unknown>): void {
    if (event.type !== 'system/message' && event.type !== 'user/message') return
    const source = fields(data['source'])
    if (event.type === 'user/message' && (typeof source['kind'] !== 'string' || ['user', 'tool', 'second-angle'].includes(source['kind']))) return
    const content = event.type === 'system/message' ? fields(data['message'])['content'] ?? data['content'] : data['content']
    const text = Array.isArray(content) ? content.map(block => fields(block)['text']).filter(item => typeof item === 'string').join('\n') : ''
    if (/\b(?:always\s+(?:use|call|invoke|run)\s+(?:a\s+|at\s+least\s+one\s+)?tools?|(?:must|required\s+to)\s+(?:use|call|invoke|run)\s+(?:a\s+|at\s+least\s+one\s+)?tools?|tools?\s+(?:calls?\s+)?(?:is|are)\s+required)\b/i.test(text)) {
      this.toolRequirement = event.type === 'system/message' ? 'visible system instruction requires tool use' : `harness context from ${JSON.stringify(source['kind'])} requires tool use`
    }
  }

  /** Preserve exact native arguments, or JSON-normalized nested arguments, in request order. */
  addCall(callId: string, name: string, args: string): ActionCall {
    const existing = this.calls.get(callId)
    if (existing !== undefined) return existing
    const call: ActionCall = { callId, name, arguments: args, order: ++this.order, status: 'requested', origin: this.toolRequirement ? 'policy-required' : this.modelCalls.has(callId) ? 'model' : 'unattributed' }
    this.calls.set(callId, call)
    return call
  }

  markBlocked(callId: string): void { this.setStatus(callId, 'blocked') }

  private setStatus(callId: string, status: ActionCall['status']): void {
    const call = this.calls.get(callId)
    if (call && call.status !== 'blocked') this.calls.set(callId, { ...call, status })
  }

  observe(event: RecordedEvent): void {
    // Replacements are compaction/history, not new actions or fresh assistant promises.
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
    const data = fields(event.data)
    this.observeRequirement(event, data)
    if (event.type === 'turn/start' && typeof data['turn'] === 'number') {
      this.turn = data['turn']; this.order = 0; this.calls = new Map(); this.statements = []; this.modelCalls = new Set()
      return
    }
    if (this.turn === undefined) return
    const nested = /^tool\/(?:ptc|code)-dispatch(?:-start)?$/.test(event.type)
    if (nested) {
      // Nested dispatch records carry root/parent call IDs rather than a turn field.
      const root = data['rootCallId'] ?? data['parentCallId']
      if (typeof root !== 'string' || !this.calls.has(root)) return
      const id = data['subCallId']
      if (typeof id !== 'string' || typeof data['name'] !== 'string') return
      if (this.calls.get(root)?.origin === 'model') this.modelCalls.add(id)
      this.addCall(id, data['name'], JSON.stringify(data['arguments'] ?? {}))
      if (!event.type.endsWith('-start')) this.setStatus(id, data['isError'] === true ? 'error' : 'returned')
      return
    }
    if (data['turn'] !== this.turn) return
    if (event.type === 'tool/call' && typeof data['callId'] === 'string' && typeof data['name'] === 'string') {
      this.addCall(data['callId'], data['name'], typeof data['arguments'] === 'string' ? data['arguments'] : '')
    } else if (event.type === 'tool/result') {
      const message = fields(data['message'])
      if (typeof message['toolCallId'] === 'string') this.setStatus(message['toolCallId'], message['isError'] === true ? 'error' : 'returned')
    } else if (event.type === 'assistant/message') {
      const content = fields(data['message'])['content']
      if (!Array.isArray(content)) return
      const order = ++this.order
      for (const block of content) {
        const item = fields(block)
        if (item['type'] === 'tool-call' && typeof item['id'] === 'string') this.modelCalls.add(item['id'])
        if ((item['type'] === 'text' || item['type'] === 'reasoning') && typeof item['text'] === 'string') {
          this.statements.push({ kind: item['type'], text: item['text'], order })
        }
      }
    }
  }

  snapshot(): ActionTurn | undefined {
    if (this.turn === undefined) return undefined
    return { turn: this.turn, calls: [...this.calls.values()], statements: [...this.statements], ...this.toolRequirement ? { toolRequirement: this.toolRequirement } : {} }
  }
}
