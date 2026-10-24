/**
 * dsh-second-angle — a second angle on every finished DeepSeek Harness turn.
 *
 * At `agent/turn-stopping` (after the final step, before `turn/end`) the plugin
 * checks the answer's claims against the tool output the turn actually read.
 * A claim the evidence contradicts steers a short correction, so the model
 * revises in the same turn; a claim the evidence does not back becomes a flag
 * (a `plugin:second-angle/verdict` Session record, a log line, and optionally a
 * notice). Turns are gated first, and every failure leaves the turn untouched.
 * @module dsh-second-angle
 */

import z from '@deepseek-ai/schemastery'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { DEFAULTS, type Config as SecondAngleConfig } from './config.ts'
import { createSecondAngle, RECORD_TYPE, type VerdictRecord } from './plugin.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Steering corrections and notices written by dsh-second-angle. */
    'second-angle': { kind: 'second-angle' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** One second-angle verdict for one turn. */
    'plugin:second-angle/verdict': VerdictRecord
  }
}

export type { ResolvedConfig } from './config.ts'

/** Plugin configuration as written in `cordis.yml`; every field is optional (see `config.ts` for each field). */
export type Config = SecondAngleConfig
export type { VerdictRecord } from './plugin.ts'
export { DEFAULT_CARD, AUDITOR_METHOD, buildAuditorPrompt } from './prompt.ts'
export { DEFAULT_ABSOLUTE_WORDS, scanAnswer } from './scanner.ts'
export { parseVerdict } from './verdict.ts'
export { routeVerdicts } from './route.ts'

/** Stable Loader identity. */
export const name = 'second-angle'

/** The auditor calls the model through `ctx.llm`. */
export const inject = ['llm']

/** Schemastery validation for {@link Config}; `resolveConfig` applies the same defaults and range checks. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  mode: z.union(['sync', 'async']).default(DEFAULTS.mode),
  maxLatencyMs: z.number().default(DEFAULTS.maxLatencyMs),
  includeSubagents: z.boolean().default(DEFAULTS.includeSubagents),
  memoryTurns: z.union(['scanner', 'skip']).default(DEFAULTS.memoryTurns),
  flagMemoryNumbers: z.boolean().default(DEFAULTS.flagMemoryNumbers),
  minAnswerChars: z.number().default(DEFAULTS.minAnswerChars),
  minEvidenceChars: z.number().default(DEFAULTS.minEvidenceChars),
  auditorProvider: z.string(),
  auditorModel: z.string(),
  auditorReasoningEffort: z.string().default(DEFAULTS.auditorReasoningEffort),
  auditorMaxTokens: z.number().default(DEFAULTS.auditorMaxTokens),
  auditorTemperature: z.number().default(DEFAULTS.auditorTemperature),
  maxEvidenceChars: z.number().default(DEFAULTS.maxEvidenceChars),
  card: z.array(z.string()).default([...DEFAULTS.card]),
  cardFile: z.string(),
  steer: z.boolean().default(DEFAULTS.steer),
  requireQuoteForSteer: z.boolean().default(DEFAULTS.requireQuoteForSteer),
  maxListedClaims: z.number().default(DEFAULTS.maxListedClaims),
  flagRecord: z.boolean().default(DEFAULTS.flagRecord),
  flagLog: z.boolean().default(DEFAULTS.flagLog),
  flagStderr: z.boolean().default(DEFAULTS.flagStderr),
  flagNotice: z.boolean().default(DEFAULTS.flagNotice),
  asyncContradicted: z.union(['notice', 'followup', 'flag']).default(DEFAULTS.asyncContradicted),
  recordSkips: z.boolean().default(DEFAULTS.recordSkips),
  absoluteWords: z.array(z.string()).default([...DEFAULTS.absoluteWords]),
  extraUnits: z.array(z.string()).default([...DEFAULTS.extraUnits]),
})

/** Mount the plugin: fold turns, audit at the stop boundary, route by severity. */
export const apply = createSecondAngle({
  createUserMessage: input => createUserMessage({ content: [...input.content], source: input.source }),
  appendRecord: (session, data) => { appendPluginRecord(session, RECORD_TYPE, data) },
  now: () => performance.now(),
  writeDiagnostic: (line) => { process.stderr.write(`${line}\n`) },
})
