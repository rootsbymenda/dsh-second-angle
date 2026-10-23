/**
 * The words the plugin puts in front of the model and the human: the steered
 * correction, the one-line flag, and the scanner-only flag for turns that read
 * nothing. Each claim is quoted short so a message never grows with the answer.
 * @module dsh-second-angle/messages
 */

import type { ScanFinding } from './scanner.ts'
import type { ClaimVerdict } from './verdict.ts'

/** The bound the harness applies to a notice summary (`CONTEXT_SUMMARY_MAX_CHARS` in `@deepseek-ai/dsh-llm`). */
export const SUMMARY_MAX_CHARS = 120

/** Longest claim or quote excerpt carried in a message. */
const EXCERPT_MAX_CHARS = 200

/** Cap one excerpt and fold its whitespace. */
function excerpt(text: string): string {
  const folded = text.replace(/\s+/g, ' ').trim()
  return folded.length > EXCERPT_MAX_CHARS ? `${folded.slice(0, EXCERPT_MAX_CHARS - 1)}…` : folded
}

/** Cap a one-line summary to the notice bound. */
export function boundSummary(summary: string): string {
  return summary.length <= SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/** `1 claim` / `2 claims`. */
function claims(count: number): string {
  return `${String(count)} claim${count === 1 ? '' : 's'}`
}

/**
 * The steering message that asks the model to correct its answer in the same turn.
 * @param contradicted - contradictions that qualified for steering.
 * @param maxClaims - most claims listed; the rest are counted.
 * @returns the message text.
 */
export function steerText(contradicted: readonly ClaimVerdict[], maxClaims: number): string {
  const listed = contradicted.slice(0, maxClaims)
  const lines = listed.map((claim, index) => {
    const quote = claim.quote === undefined ? '' : ` The tool output shows: "${excerpt(claim.quote)}".`
    const reason = claim.reason.length > 0 ? ` (${excerpt(claim.reason)})` : ''
    return `${String(index + 1)}. You wrote: "${excerpt(claim.claim)}".${quote}${reason}`
  })
  const more = contradicted.length > listed.length ? [`(and ${claims(contradicted.length - listed.length)} more of the same kind)`] : []
  return [
    'Second angle: your answer above contradicts the tool output you read in this turn.',
    ...lines,
    ...more,
    'Correct the answer now: change only what the tool output contradicts, keep everything else, and say in one line what you corrected.',
  ].join('\n')
}

/** The one-line summary shown for the steering message. */
export function steerSummary(count: number): string {
  return boundSummary(`second angle: ${claims(count)} contradicted by this turn's reads; asking for a correction`)
}

/**
 * The flag line for claims the turn's reads do not back.
 * @param flagged - flagged claims.
 * @param maxClaims - most claims listed; the rest are counted.
 * @returns one line naming each claim, its label, and the reason.
 */
export function flagText(flagged: readonly ClaimVerdict[], maxClaims: number): string {
  const listed = flagged.slice(0, maxClaims).map((claim, index) =>
    `(${String(index + 1)}) "${excerpt(claim.claim)}" (${claim.label}${claim.reason.length > 0 ? `: ${excerpt(claim.reason)}` : ''})`)
  const more = flagged.length > maxClaims ? ` (+${String(flagged.length - maxClaims)} more)` : ''
  return `second angle: ${claims(flagged.length)} not backed by this turn's reads: ${listed.join('; ')}${more}`
}

/**
 * The flag line for a turn that read nothing: scanner findings only, never a model verdict.
 * @param findings - scanner findings reported for the turn.
 * @param maxClaims - most findings listed; the rest are counted.
 * @returns one line naming each sentence and what the scanner saw in it.
 */
export function scannerFlagText(findings: readonly ScanFinding[], maxClaims: number): string {
  const listed = findings.slice(0, maxClaims).map((finding, index) => {
    const what = finding.kind === 'absolute-word' ? `absolute word "${finding.match}"` : `number "${finding.match}"`
    return `(${String(index + 1)}) "${excerpt(finding.sentence)}" (${what})`
  })
  const more = findings.length > maxClaims ? ` (+${String(findings.length - maxClaims)} more)` : ''
  return `second angle: ${claims(findings.length)} with no read in this turn to back them: ${listed.join('; ')}${more}`
}

/**
 * The notice injected after the turn closes, when notice delivery is on. The
 * model reads it with the next turn; the Web chat shows its summary as a row.
 * @param turn - the audited turn.
 * @param line - the flag line produced by {@link flagText} or {@link scannerFlagText}.
 * @returns the notice text.
 */
export function noticeText(turn: number, line: string): string {
  return `Second angle on your answer in turn ${String(turn)}: ${line.replace(/^second angle: /, '')}\nIf these claims matter to the task, check them before relying on them.`
}

/** The one-line summary of an injected notice. */
export function noticeSummary(count: number): string {
  return boundSummary(`second angle: ${claims(count)} in the last answer not backed by its reads`)
}
