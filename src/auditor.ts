/**
 * The auditor's model call, following the precedent of the harness
 * `auto-review` plugin: a hand-built `GenerateOptions` sent through
 * `ctx.llm.stream`, never written to the Session log. The stream is folded
 * here rather than with `BlockAssembler` so a cut-off output (no terminal
 * `finish`, or `max-tokens`) still yields its text for salvage.
 * @module dsh-second-angle/auditor
 */

import type { GenerateOptions, ReasoningEffortId, StreamChunk } from '@deepseek-ai/dsh-llm'

/** The slice of `ctx.llm` the auditor uses. */
export interface AuditorLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ readonly reasoning?: { readonly efforts: readonly { readonly id: string }[] } }>
}

/** One auditor call. */
export interface AuditorCall {
  readonly provider: string
  readonly model: string
  /** Sent only when the route offers it (see {@link resolveEffort}). */
  readonly reasoningEffort?: string
  readonly maxTokens: number
  readonly temperature: number
  readonly system: string
  readonly user: string
  readonly signal: AbortSignal
}

/** What the auditor printed and how the call ended. */
export interface AuditorOutput {
  /** The printed text (reasoning blocks are never read). */
  readonly text: string
  /** `stop`, `max-tokens`, `tool-calls`, or `none` when the stream ended without a terminal chunk. */
  readonly finish: string
  /** Output tokens, when the adapter reported usage. */
  readonly outputTokens?: number
}

/** A call that produced no usable stream outcome. */
export class AuditorCallError extends Error {
  /** `aborted` (cancelled or timed out), `error` (the provider or adapter failed), or `no-output`. */
  readonly code: 'aborted' | 'error' | 'no-output'

  /**
   * @param message - what went wrong, for the log and the verdict record.
   * @param code - the failure class.
   */
  constructor(message: string, code: 'aborted' | 'error' | 'no-output') {
    super(message)
    this.name = 'AuditorCallError'
    this.code = code
  }
}

/**
 * Run one auditor call and fold its stream.
 * @param llm - the harness LLM service (or a test double).
 * @param call - the request.
 * @returns the printed text and the finish reason.
 * @throws AuditorCallError when the call is aborted, fails, or ends with no text.
 */
export async function runAuditorCall(llm: AuditorLlm, call: AuditorCall): Promise<AuditorOutput> {
  const options: GenerateOptions = {
    provider: call.provider,
    model: call.model,
    system: call.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: call.user }] }],
    maxTokens: call.maxTokens,
    temperature: call.temperature,
    signal: call.signal,
    ...call.reasoningEffort === undefined ? {} : { reasoningEffort: call.reasoningEffort as ReasoningEffortId },
  }
  const texts = new Map<number, string>()
  let finish = 'none'
  let outputTokens: number | undefined
  for await (const chunk of llm.stream(options)) {
    switch (chunk.type) {
      case 'text-delta':
        texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text)
        break
      case 'block-end':
        if (chunk.block.type === 'text') texts.set(chunk.index, chunk.block.text)
        break
      case 'usage':
        outputTokens = chunk.usage.outputTokens
        break
      case 'finish':
        if (chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error') {
          throw new AuditorCallError(`auditor call ended with ${chunk.reason.kind}: ${chunk.reason.failure.message}`, chunk.reason.kind === 'aborted' ? 'aborted' : 'error')
        }
        finish = chunk.reason.kind
        break
      default:
        break
    }
  }
  const text = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]).join('')
  if (text.trim().length === 0 && finish === 'none') throw new AuditorCallError('auditor stream ended with no text and no finish', 'no-output')
  return { text, finish, ...outputTokens === undefined ? {} : { outputTokens } }
}

/** The effort decision for one route. */
export interface EffortDecision {
  /** The effort to send, when the route offers it. */
  readonly effort?: string
  /** Why the wanted effort is not sent, for a one-time log line. */
  readonly note?: string
  /** Set when the lookup itself failed (for example it was cancelled); such a decision is not cached. */
  readonly transient?: true
}

/**
 * Decide whether the configured effort (default `off`) can be sent on a route.
 * @param llm - the harness LLM service.
 * @param provider - the auditor route.
 * @param model - the auditor model.
 * @param wanted - the configured effort id; empty sends none.
 * @param signal - cancellation for the adapter lookup.
 * @returns the effort to send, or a note explaining why none is sent.
 */
export async function resolveEffort(llm: AuditorLlm, provider: string, model: string, wanted: string, signal: AbortSignal): Promise<EffortDecision> {
  if (wanted.length === 0) return {}
  try {
    const info = await llm.resolveModelInfo(provider, model, signal)
    const offered = info.reasoning?.efforts.map(effort => effort.id) ?? []
    if (offered.includes(wanted)) return { effort: wanted }
    return { note: `route ${provider}/${model} offers no "${wanted}" reasoning effort (offers: ${offered.length > 0 ? offered.join(', ') : 'none'}); the auditor runs at the route default and may be slower` }
  } catch (error: unknown) {
    return { note: `could not read the reasoning efforts of ${provider}/${model} (${error instanceof Error ? error.message : String(error)}); the auditor runs at the route default`, transient: true }
  }
}
