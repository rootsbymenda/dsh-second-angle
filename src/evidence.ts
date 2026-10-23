/**
 * Renders a turn's own tool calls and outputs as the auditor's evidence text.
 * The whole output of every call goes in; only when the total exceeds the
 * configured cap is each output shortened (head and tail kept, the middle
 * replaced by a marker), and the result says so.
 * @module dsh-second-angle/evidence
 */

import type { ToolEvidence } from './turn-record.ts'

/** The rendered evidence plus the facts the verdict record keeps about it. */
export interface Evidence {
  /** The evidence text handed to the auditor. */
  readonly text: string
  /** Characters of tool output before any shortening. */
  readonly sourceChars: number
  /** Whether any output was shortened to fit the cap. */
  readonly truncated: boolean
  /** Number of tool results rendered. */
  readonly tools: number
}

/** Arguments longer than this are cut in the call header; the output is what the auditor checks against. */
const MAX_ARGUMENT_CHARS = 600

/** Shorten one text to `budget` characters, keeping its head and tail. */
function shorten(text: string, budget: number): string {
  if (text.length <= budget) return text
  const marker = `\n[... ${String(text.length - budget)} characters omitted by second-angle ...]\n`
  const keep = Math.max(0, budget - marker.length)
  const head = Math.ceil(keep * 0.6)
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head))
}

/** Split `cap` characters across outputs: small outputs keep everything, the rest share what remains. */
function budgets(lengths: readonly number[], cap: number): number[] {
  const result = lengths.map(() => 0)
  let remaining = cap
  let open = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length)
  while (open.length > 0) {
    const share = Math.floor(remaining / open.length)
    const smallest = open[0]
    if (smallest === undefined) break
    if (smallest.length <= share) {
      result[smallest.index] = smallest.length
      remaining -= smallest.length
      open = open.slice(1)
      continue
    }
    for (const entry of open) result[entry.index] = share
    break
  }
  return result
}

/**
 * Render the evidence text for one turn.
 * @param tools - the turn's tool results in commit order.
 * @param maxChars - total character cap for the outputs.
 * @returns the evidence text and its accounting.
 */
export function renderEvidence(tools: readonly ToolEvidence[], maxChars: number): Evidence {
  const outputs = tools.map(tool => tool.output)
  const sourceChars = outputs.reduce((sum, output) => sum + output.length, 0)
  const truncated = sourceChars > maxChars
  const limits = truncated ? budgets(outputs.map(output => output.length), maxChars) : outputs.map(output => output.length)
  const sections = tools.map((tool, index) => {
    const args = tool.arguments.length > MAX_ARGUMENT_CHARS ? `${tool.arguments.slice(0, MAX_ARGUMENT_CHARS)}…` : tool.arguments
    const status = tool.isError ? ' (the tool reported an error)' : ''
    const output = shorten(tool.output, limits[index] ?? 0)
    return `[tool ${String(index + 1)}] ${tool.name} ${args}${status}\n--- output ---\n${output.length > 0 ? output : '(empty output)'}\n--- end of output ---`
  })
  return { text: sections.join('\n\n'), sourceChars, truncated, tools: tools.length }
}
