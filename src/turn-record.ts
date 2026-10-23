/**
 * Rebuilds one turn from the durable Session events: the tool calls it made,
 * the tool output it read, and the text of its last assistant message. The
 * `agent/turn-stopping` payload carries none of these, so the plugin folds
 * them from `session/event` as they are committed (the same pattern the
 * harness `workspace-changes` deliverable uses).
 * @module dsh-second-angle/turn-record
 */

/** The minimal event fields the recorder reads; a harness `SessionEvent` satisfies it. */
export interface RecordedEvent {
  readonly type: string
  readonly data?: unknown
  /** `append` for a new surface node; an object for a compaction replacement. */
  readonly surfaceOp?: 'append' | { readonly op: string } | undefined
}

/** One tool call of the turn and the output it returned. */
export interface ToolEvidence {
  /** The call identity pairing `tool/call` with `tool/result`. */
  readonly callId: string
  /** The tool name, or `unknown` when the call event was not observed. */
  readonly name: string
  /** The raw arguments JSON exactly as the model produced it. */
  readonly arguments: string
  /** The model-facing text of the result. */
  readonly output: string
  /** Whether the tool reported a failure. */
  readonly isError: boolean
}

/** One turn, as far as it has been committed. */
export interface TurnRecord {
  readonly turn: number
  /** Tool results committed in this turn, in commit order. */
  readonly tools: readonly ToolEvidence[]
  /** Text of the turn's last assistant message; `undefined` before any, `''` when the last one carried no text. */
  readonly finalText: string | undefined
  /** Whether the last assistant message was a cancelled, partial one. */
  readonly finalInterrupted: boolean
  /** Number of assistant messages committed in this turn. */
  readonly assistantMessages: number
  /** Whether `turn/end` has been committed for this turn. */
  readonly closed: boolean
}

interface MutableTurn {
  turn: number
  calls: Map<string, { name: string; arguments: string }>
  tools: ToolEvidence[]
  finalText: string | undefined
  finalInterrupted: boolean
  assistantMessages: number
  closed: boolean
}

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Join the text blocks of a message content array. */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const fields = record(block)
    if (fields?.['type'] === 'text' && typeof fields['text'] === 'string') parts.push(fields['text'])
  }
  return parts.join('')
}

/** Folds one Session's events into the record of its current turn. */
export class TurnRecorder {
  private state: MutableTurn | undefined

  /**
   * Fold one committed event. Events of other turns, compaction replacements of
   * older tool results, and unknown event types are ignored.
   * @param event - one committed Session event.
   */
  observe(event: RecordedEvent): void {
    const data = record(event.data)
    if (data === undefined) return
    if (event.type === 'turn/start') {
      if (typeof data['turn'] !== 'number') return
      this.state = { turn: data['turn'], calls: new Map(), tools: [], finalText: undefined, finalInterrupted: false, assistantMessages: 0, closed: false }
      return
    }
    const state = this.state
    if (state === undefined || data['turn'] !== state.turn) return
    switch (event.type) {
      case 'tool/call': {
        if (typeof data['callId'] !== 'string') return
        state.calls.set(data['callId'], {
          name: typeof data['name'] === 'string' ? data['name'] : 'unknown',
          arguments: typeof data['arguments'] === 'string' ? data['arguments'] : '',
        })
        return
      }
      case 'tool/result': {
        // Compaction rewrites older results in place; only an appended result is this turn's read.
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
        const message = record(data['message'])
        if (message === undefined) return
        const callId = typeof message['toolCallId'] === 'string' ? message['toolCallId'] : ''
        const call = state.calls.get(callId)
        state.tools.push({
          callId,
          name: call?.name ?? 'unknown',
          arguments: call?.arguments ?? '',
          output: textOfContent(message['content']),
          isError: message['isError'] === true,
        })
        return
      }
      case 'assistant/message': {
        const message = record(data['message'])
        state.finalText = textOfContent(message?.['content'])
        state.finalInterrupted = data['interrupted'] === true
        state.assistantMessages += 1
        return
      }
      case 'turn/end':
        state.closed = true
        return
      default:
        return
    }
  }

  /**
   * Whether `turn` is over: closed by `turn/end`, or superseded by a later `turn/start`.
   * @param turn - a turn number.
   * @returns `true` once the turn can take no further step.
   */
  isClosed(turn: number): boolean {
    const state = this.state
    if (state === undefined) return true
    return state.turn > turn || (state.turn === turn && state.closed)
  }

  /**
   * The record of `turn`, when it is the turn this recorder last saw open.
   * @param turn - the turn number from the `agent/turn-stopping` payload.
   * @returns a snapshot of the turn, or `undefined` when its start was not observed.
   */
  snapshot(turn: number): TurnRecord | undefined {
    const state = this.state
    if (state === undefined || state.turn !== turn) return undefined
    return {
      turn: state.turn,
      tools: [...state.tools],
      finalText: state.finalText,
      finalInterrupted: state.finalInterrupted,
      assistantMessages: state.assistantMessages,
      closed: state.closed,
    }
  }
}
