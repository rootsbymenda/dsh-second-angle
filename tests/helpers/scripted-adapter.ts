import type { GenerateOptions, LlmModelReasoningInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

/** One scripted model reply: chunks, a function of the request, delayed chunks, `hang` (waits until aborted), `stall` (never settles, ignores the abort), or `throw`. */
export type ScriptEntry =
  | StreamChunk[]
  | ((options: GenerateOptions) => StreamChunk[])
  | { readonly delayMs: number; readonly chunks: StreamChunk[] }
  | 'hang'
  | 'stall'
  | 'throw'

/** A text reply that ends with `stop`. */
export function textReply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A reply that calls one tool. */
export function toolReply(callId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(callId)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A model adapter that replays a script, one entry per request, and records every request. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly script: ScriptEntry[]
  private readonly reasoning: LlmModelReasoningInfo | undefined

  constructor(script: ScriptEntry[], reasoning?: LlmModelReasoningInfo) {
    super()
    this.script = script
    this.reasoning = reasoning
  }

  /** Entries not consumed yet. */
  get remaining(): number {
    return this.script.length
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.reasoning === undefined ? {} : { reasoning: this.reasoning } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry === 'throw') throw new Error('scripted provider failure')
    if (entry === 'stall') {
      // Ignores the abort signal on purpose: an adapter that never settles.
      await new Promise<void>(() => {})
      return
    }
    if (entry === 'hang') {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    if (!Array.isArray(entry) && typeof entry === 'object') {
      await new Promise(resolve => setTimeout(resolve, entry.delayMs))
      for (const chunk of entry.chunks) yield chunk
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) yield chunk
  }
}
