/**
 * Plugin configuration: every tunable is a `cordis.yml` field with a default,
 * resolved and validated once at load. A bad value fails the plugin load.
 * @module dsh-second-angle/config
 */

import { DEFAULT_ABSOLUTE_WORDS } from './scanner.ts'
import { DEFAULT_CARD } from './prompt.ts'

/** Plugin configuration as written in `cordis.yml`; every field is optional. */
export interface Config {
  /** Master switch; `false` registers no listener. Default `true`. */
  enabled?: boolean
  /**
   * `sync` waits for the verdict before the turn closes, bounded by `maxLatencyMs`, so a
   * contradiction can steer a correction in the same turn. `async` lets the turn close at once
   * and attaches the verdict when it arrives. Default `sync`.
   */
  mode?: 'sync' | 'async'
  /** Milliseconds one audit may take; past it the audit is abandoned and the turn goes on. Default 45000. */
  maxLatencyMs?: number
  /** Also audit turns of sub-agent sessions. Default `false`. */
  includeSubagents?: boolean
  /**
   * A turn that ran no tool has no evidence to audit against, and a model auditor flags every
   * claim of such a turn. `scanner` reports the scanner's absolute-word findings as a flag (no
   * model call); `skip` leaves such turns alone. Default `scanner`.
   */
  memoryTurns?: 'scanner' | 'skip'
  /** In a turn that ran no tool, also flag numbers with units (they cannot be checked against anything). Default `false`. */
  flagMemoryNumbers?: boolean
  /** Answers shorter than this many characters are not audited. Default 20. */
  minAnswerChars?: number
  /** When the scanner finds nothing, the model is still called if the turn read at least this many characters of tool output. Default 200. */
  minEvidenceChars?: number
  /** Auditor route; default the audited turn's own provider. */
  auditorProvider?: string
  /** Auditor model; default the audited turn's own model. */
  auditorModel?: string
  /** Reasoning effort id for the auditor; sent only when the route offers it; `''` sends none. Default `off`. */
  auditorReasoningEffort?: string
  /** Hard output cap of the auditor call, in tokens. Default 2048. */
  auditorMaxTokens?: number
  /** Auditor sampling temperature. Default 0. */
  auditorTemperature?: number
  /** Character cap for the evidence text; longer tool output is shortened (head and tail kept). Default 48000. */
  maxEvidenceChars?: number
  /** Facts-and-limits card lines for the auditor; replaces the default card. */
  card?: string[]
  /** A UTF-8 file whose non-empty lines are appended to the card; read once at load. */
  cardFile?: string
  /** Steer a correction when a claim is contradicted (sync mode). Default `true`. */
  steer?: boolean
  /** Steer only when the contradiction cites text that occurs in the evidence. Default `true`. */
  requireQuoteForSteer?: boolean
  /** Most claims listed in one steering message or flag line. Default 3. */
  maxListedClaims?: number
  /** Write each verdict as a `plugin:second-angle/verdict` Session record. Default `true`. */
  flagRecord?: boolean
  /** Write each flag as a warning in the process log. Default `true`. */
  flagLog?: boolean
  /** Inject each flag as a notice once the turn has closed (model-visible with the next turn). Default `false`. */
  flagNotice?: boolean
  /** Async mode only: what a contradiction does once the turn has closed. Default `notice`. */
  asyncContradicted?: 'notice' | 'followup' | 'flag'
  /** Also record skipped turns and the gate that skipped them. Default `false`. */
  recordSkips?: boolean
  /** Absolute words for the scanner; replaces the default list. */
  absoluteWords?: string[]
  /** Extra unit spellings for the scanner's number-with-unit pattern. */
  extraUnits?: string[]
}

/** The fully resolved configuration the plugin runs with. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly mode: 'sync' | 'async'
  readonly maxLatencyMs: number
  readonly includeSubagents: boolean
  readonly memoryTurns: 'scanner' | 'skip'
  readonly flagMemoryNumbers: boolean
  readonly minAnswerChars: number
  readonly minEvidenceChars: number
  readonly auditorProvider: string | undefined
  readonly auditorModel: string | undefined
  readonly auditorReasoningEffort: string
  readonly auditorMaxTokens: number
  readonly auditorTemperature: number
  readonly maxEvidenceChars: number
  readonly card: readonly string[]
  readonly cardFile: string | undefined
  readonly steer: boolean
  readonly requireQuoteForSteer: boolean
  readonly maxListedClaims: number
  readonly flagRecord: boolean
  readonly flagLog: boolean
  readonly flagNotice: boolean
  readonly asyncContradicted: 'notice' | 'followup' | 'flag'
  readonly recordSkips: boolean
  readonly absoluteWords: readonly string[]
  readonly extraUnits: readonly string[]
}

/** The defaults, in one place. */
export const DEFAULTS: ResolvedConfig = {
  enabled: true,
  mode: 'sync',
  maxLatencyMs: 45_000,
  includeSubagents: false,
  memoryTurns: 'scanner',
  flagMemoryNumbers: false,
  minAnswerChars: 20,
  minEvidenceChars: 200,
  auditorProvider: undefined,
  auditorModel: undefined,
  auditorReasoningEffort: 'off',
  auditorMaxTokens: 2048,
  auditorTemperature: 0,
  maxEvidenceChars: 48_000,
  card: DEFAULT_CARD,
  cardFile: undefined,
  steer: true,
  requireQuoteForSteer: true,
  maxListedClaims: 3,
  flagRecord: true,
  flagLog: true,
  flagNotice: false,
  asyncContradicted: 'notice',
  recordSkips: false,
  absoluteWords: DEFAULT_ABSOLUTE_WORDS,
  extraUnits: [],
}

/** Require a positive safe integer. */
function positiveInteger(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`second-angle: ${field} must be a positive integer, got ${String(value)}`)
  return value
}

/** Require a member of a closed set. */
function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  const match = allowed.find(item => item === value)
  if (match === undefined) throw new Error(`second-angle: ${field} must be one of ${allowed.join(', ')}, got "${value}"`)
  return match
}

/** Treat a blank string as absent. */
function optionalText(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value.trim()
}

/**
 * Resolve the configuration: apply defaults and validate every field.
 * @param config - the row's `config` value (already shaped by the plugin schema, or raw in tests).
 * @returns the resolved configuration.
 * @throws Error naming the field when a value is invalid.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const temperature = config.auditorTemperature ?? DEFAULTS.auditorTemperature
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`second-angle: auditorTemperature must be between 0 and 2, got ${String(temperature)}`)
  }
  const auditorProvider = optionalText(config.auditorProvider)
  const auditorModel = optionalText(config.auditorModel)
  if ((auditorProvider === undefined) !== (auditorModel === undefined)) {
    throw new Error('second-angle: auditorProvider and auditorModel must be set together')
  }
  return {
    enabled: config.enabled ?? DEFAULTS.enabled,
    mode: oneOf('mode', config.mode ?? DEFAULTS.mode, ['sync', 'async'] as const),
    maxLatencyMs: positiveInteger('maxLatencyMs', config.maxLatencyMs ?? DEFAULTS.maxLatencyMs),
    includeSubagents: config.includeSubagents ?? DEFAULTS.includeSubagents,
    memoryTurns: oneOf('memoryTurns', config.memoryTurns ?? DEFAULTS.memoryTurns, ['scanner', 'skip'] as const),
    flagMemoryNumbers: config.flagMemoryNumbers ?? DEFAULTS.flagMemoryNumbers,
    minAnswerChars: positiveInteger('minAnswerChars', config.minAnswerChars ?? DEFAULTS.minAnswerChars),
    minEvidenceChars: positiveInteger('minEvidenceChars', config.minEvidenceChars ?? DEFAULTS.minEvidenceChars),
    auditorProvider,
    auditorModel,
    auditorReasoningEffort: (config.auditorReasoningEffort ?? DEFAULTS.auditorReasoningEffort).trim(),
    auditorMaxTokens: positiveInteger('auditorMaxTokens', config.auditorMaxTokens ?? DEFAULTS.auditorMaxTokens),
    auditorTemperature: temperature,
    maxEvidenceChars: positiveInteger('maxEvidenceChars', config.maxEvidenceChars ?? DEFAULTS.maxEvidenceChars),
    card: config.card ?? DEFAULTS.card,
    cardFile: optionalText(config.cardFile),
    steer: config.steer ?? DEFAULTS.steer,
    requireQuoteForSteer: config.requireQuoteForSteer ?? DEFAULTS.requireQuoteForSteer,
    maxListedClaims: positiveInteger('maxListedClaims', config.maxListedClaims ?? DEFAULTS.maxListedClaims),
    flagRecord: config.flagRecord ?? DEFAULTS.flagRecord,
    flagLog: config.flagLog ?? DEFAULTS.flagLog,
    flagNotice: config.flagNotice ?? DEFAULTS.flagNotice,
    asyncContradicted: oneOf('asyncContradicted', config.asyncContradicted ?? DEFAULTS.asyncContradicted, ['notice', 'followup', 'flag'] as const),
    recordSkips: config.recordSkips ?? DEFAULTS.recordSkips,
    absoluteWords: config.absoluteWords ?? DEFAULTS.absoluteWords,
    extraUnits: config.extraUnits ?? DEFAULTS.extraUnits,
  }
}
