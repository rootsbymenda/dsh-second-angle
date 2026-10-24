/**
 * The second-angle plugin body. It folds each Session's events into the
 * record of the current turn, and at `agent/turn-stopping` it gates, scans,
 * audits, and routes: a contradiction steers a correction in the same turn,
 * an unbacked claim becomes a flag. Every failure is contained: an audit
 * that errors, times out, or prints nothing leaves the turn exactly as it was.
 *
 * Harness runtime functions arrive through {@link HarnessRuntime} so this
 * module carries type imports only.
 * @module dsh-second-angle/plugin
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { AuditorCallError, resolveEffort, runAuditorCall, type AuditorLlm, type EffortDecision } from './auditor.ts'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { renderEvidence, type Evidence } from './evidence.ts'
import {
  flagText, noticeSummary, noticeText, scannerFlagText, steerSummary, steerText,
} from './messages.ts'
import { buildAuditorPrompt } from './prompt.ts'
import { routeVerdicts } from './route.ts'
import { scanAnswer, type ScanFinding, type ScanResult } from './scanner.ts'
import { TurnRecorder, type RecordedEvent, type TurnRecord } from './turn-record.ts'
import { parseVerdict, type ClaimVerdict, type Label } from './verdict.ts'

/** The plugin record type every verdict is written under. */
export const RECORD_TYPE = 'plugin:second-angle/verdict'

/** The message source stamped on everything this plugin steers or injects. */
export const SOURCE_KIND = 'second-angle'

/** Extra wait past `maxLatencyMs` (and on unload) before the plugin stops waiting for an audit whose abort was not honored. */
const SYNC_GRACE_MS = 1000

/** One verdict as written to the Session log; plain JSON. */
export interface VerdictRecord {
  readonly v: 1
  readonly turn: number
  /** What happened to the turn. */
  readonly status: 'clean' | 'flagged' | 'steered' | 'skipped' | 'no-verdict' | 'error' | 'timeout'
  /** Who produced the claims: the model auditor, the scanner alone, or neither. */
  readonly source: 'auditor' | 'scanner' | 'none'
  readonly mode: 'sync' | 'async'
  /** The gate that skipped the turn, the failure, or a note about the route. */
  readonly detail?: string
  readonly route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly latencyMs?: number
  readonly finish?: string
  readonly evidence?: { readonly tools: number; readonly chars: number; readonly truncated: boolean }
  readonly scanner?: { readonly absolutes: readonly string[]; readonly numbersNotInEvidence: readonly string[] }
  readonly claims?: readonly {
    readonly claim: string
    readonly label: Label
    readonly reason: string
    readonly quote?: string
    readonly quoteFound: boolean
  }[]
  /** The channels the result went out on: `steer`, `followup`, `stderr`, `log`, `notice`. */
  readonly delivered: readonly string[]
}

/** Harness runtime functions the plugin calls; `index.ts` passes the real ones. */
export interface HarnessRuntime {
  /** `createUserMessage` from `@deepseek-ai/dsh-llm`. */
  readonly createUserMessage: (input: { readonly content: readonly ContentBlock[]; readonly source: MessageSource }) => UserMessage
  /** `appendPluginRecord` from `@deepseek-ai/dsh-session`, bound to this plugin's record type. */
  readonly appendRecord: (session: Session, data: VerdictRecord) => void
  /** Monotonic milliseconds; `performance.now` in production. */
  readonly now: () => number
  /** Write one diagnostic line; the process's stderr in production. */
  readonly writeDiagnostic: (line: string) => void
}

/** A deferred notice waiting for its turn to close. */
interface PendingNotice {
  readonly turn: number
  readonly agent: Agent
  readonly message: UserMessage
}

/** Describe an unknown failure in one line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a Session belongs to a sub-agent (the `workspace-changes` eligibility rule). */
function isSubagent(session: Session): boolean {
  const { origin, delegationDepth } = session.header
  return origin === 'subagent' || (delegationDepth ?? 0) > 0
}

/** Plain-JSON form of the scanner findings for a record. */
function scannerSummary(scan: ScanResult): NonNullable<VerdictRecord['scanner']> {
  return {
    absolutes: scan.absolutes.map(finding => finding.match),
    numbersNotInEvidence: scan.numbersNotInEvidence.map(finding => finding.match),
  }
}

/** Plain-JSON form of the audited claims for a record. */
function claimsSummary(claims: readonly ClaimVerdict[]): NonNullable<VerdictRecord['claims']> {
  return claims.map(claim => ({
    claim: claim.claim,
    label: claim.label,
    reason: claim.reason,
    ...claim.quote === undefined ? {} : { quote: claim.quote },
    quoteFound: claim.quoteFound,
  }))
}

/**
 * Read the optional card file: its non-empty lines, trimmed.
 * @param path - the configured file, or `undefined`.
 * @returns the card lines it adds.
 * @throws when the file is configured but unreadable (misconfiguration fails the load).
 */
function readCardFile(path: string | undefined): string[] {
  if (path === undefined) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).map(line => line.replace(/^\s*-\s*/, '').trim()).filter(line => line.length > 0)
}

/**
 * Create the plugin's `apply` over the given harness runtime.
 * @param runtime - harness runtime functions.
 * @returns the Cordis `apply(ctx, config)` function.
 */
export function createSecondAngle(runtime: HarnessRuntime): (ctx: Context, raw: Config | undefined) => void {
  return function apply(ctx: Context, raw: Config | undefined): void {
    const config: ResolvedConfig = resolveConfig(raw ?? {})
    if (!config.enabled) {
      ctx.logger.info('second-angle: disabled by configuration')
      return
    }
    const card = [...config.card, ...readCardFile(config.cardFile)]
    const scanOptions = { absoluteWords: config.absoluteWords, extraUnits: config.extraUnits }
    const llm: AuditorLlm = ctx.llm
    const recorders = new WeakMap<Session, TurnRecorder>()
    const audited = new WeakMap<Session, Set<number>>()
    const pending = new WeakMap<Session, PendingNotice[]>()
    const efforts = new Map<string, Promise<EffortDecision>>()
    const inflight = new Set<Promise<void>>()
    const lifetime = new AbortController()

    ctx.effect(() => async () => {
      lifetime.abort()
      // Aborted audits settle promptly; one whose adapter ignores the abort is not waited for past the grace period.
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, SYNC_GRACE_MS) })
      await Promise.race([Promise.allSettled(inflight), bound])
      clearTimeout(timer)
    }, 'second-angle: abandon audits in flight')

    /** Write one verdict record; a write failure is logged, never thrown. */
    const record = (session: Session, data: VerdictRecord): void => {
      if (!config.flagRecord) return
      try {
        runtime.appendRecord(session, data)
      } catch (error: unknown) {
        ctx.logger.warn(`second-angle: could not record the verdict of turn ${String(data.turn)}: ${describe(error)}`)
      }
    }

    /** Inject one notice now; the agent may be gone, which is logged. */
    const injectNow = (notice: PendingNotice): void => {
      if (lifetime.signal.aborted) return
      try {
        notice.agent.inject(notice.message)
      } catch (error: unknown) {
        ctx.logger.warn(`second-angle: could not deliver the notice for turn ${String(notice.turn)}: ${describe(error)}`)
      }
    }

    /**
     * Deliver a notice once its turn has closed. An inject inside `agent/turn-stopping`
     * would land in the next-step inbox and force another step, so it waits for
     * `turn/end` and then leaves the publication before injecting.
     */
    const queueNotice = (agent: Agent, turn: number, message: UserMessage): void => {
      const notice: PendingNotice = { turn, agent, message }
      const recorder = recorders.get(agent.session)
      if (recorder === undefined || recorder.isClosed(turn)) {
        setTimeout(() => { injectNow(notice) }, 0)
        return
      }
      const list = pending.get(agent.session) ?? []
      list.push(notice)
      pending.set(agent.session, list)
    }

    /** Release the notices of a closed turn, outside the event publication. */
    const releaseNotices = (session: Session, turn: number): void => {
      const list = pending.get(session)
      if (list === undefined) return
      const ready = list.filter(notice => notice.turn <= turn)
      const waiting = list.filter(notice => notice.turn > turn)
      if (waiting.length > 0) pending.set(session, waiting)
      else pending.delete(session)
      for (const notice of ready) setTimeout(() => { injectNow(notice) }, 0)
    }

    /** Build a message stamped with this plugin's notice-form source. */
    const message = (text: string, summary: string): UserMessage => runtime.createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'notice', summary },
    })

    /** Deliver a flag line on the configured channels; returns the channels used. */
    const deliverFlag = (agent: Agent, turn: number, line: string, count: number, forceNotice = false): string[] => {
      const delivered: string[] = []
      if (config.flagStderr) {
        try {
          runtime.writeDiagnostic(`${line} [turn ${String(turn)}]`)
          delivered.push('stderr')
        } catch (error: unknown) {
          ctx.logger.warn(`second-angle: could not write the flag to stderr: ${describe(error)}`)
        }
      }
      if (config.flagLog) {
        ctx.logger.warn(`${line} [turn ${String(turn)}]`)
        delivered.push('log')
      }
      if (config.flagNotice || forceNotice) {
        queueNotice(agent, turn, message(noticeText(turn, line), noticeSummary(count)))
        delivered.push('notice')
      }
      return delivered
    }

    /** The auditor route: configured, else the turn's own request route, else the agent options. */
    const auditorRoute = (agent: Agent): { provider: string; model: string } | undefined => {
      if (config.auditorProvider !== undefined && config.auditorModel !== undefined) {
        return { provider: config.auditorProvider, model: config.auditorModel }
      }
      const header = agent.session.requestHeader()
      if (header !== undefined && header.config.provider.length > 0 && header.config.model.length > 0) {
        return { provider: header.config.provider, model: header.config.model }
      }
      const { provider, model } = agent.options
      return provider !== undefined && model !== undefined ? { provider, model } : undefined
    }

    /** The effort decision for a route, resolved once per route and logged once. */
    const effortFor = (route: { provider: string; model: string }, signal: AbortSignal): Promise<EffortDecision> => {
      const key = `${route.provider}\u0000${route.model}`
      let decision = efforts.get(key)
      if (decision === undefined) {
        decision = resolveEffort(llm, route.provider, route.model, config.auditorReasoningEffort, signal).then((result) => {
          if (result.note !== undefined) ctx.logger.warn(`second-angle: ${result.note}`)
          // A failed lookup (for example a cancelled turn) is retried on the next audit instead of sticking.
          if (result.transient === true) efforts.delete(key)
          return result
        })
        efforts.set(key, decision)
      }
      return decision
    }

    /** Fall back to the scanner's absolute words when the auditor gave no verdict. */
    const scannerFallback = (agent: Agent, turn: number, scan: ScanResult): string[] =>
      scan.absolutes.length === 0 ? [] : deliverFlag(agent, turn, scannerFlagText(scan.absolutes, config.maxListedClaims), scan.absolutes.length)

    /** Run the model audit of one tool-using turn and deliver its result. */
    const audit = async (
      agent: Agent, turn: number, answer: string, evidence: Evidence, scan: ScanResult, turnSignal: AbortSignal,
    ): Promise<void> => {
      const base = {
        v: 1 as const, turn, mode: config.mode,
        evidence: { tools: evidence.tools, chars: evidence.sourceChars, truncated: evidence.truncated },
        scanner: scannerSummary(scan),
      }
      const route = auditorRoute(agent)
      if (route === undefined) {
        ctx.logger.warn(`second-angle: no provider/model route for turn ${String(turn)}; not audited`)
        record(agent.session, { ...base, status: 'error', source: 'none', detail: 'no auditor route', delivered: [] })
        return
      }
      const timeout = AbortSignal.timeout(config.maxLatencyMs)
      const signal = config.mode === 'sync'
        ? AbortSignal.any([turnSignal, lifetime.signal, timeout])
        : AbortSignal.any([lifetime.signal, timeout])
      const effort = await effortFor(route, signal)
      const routeRecord = { ...route, ...effort.effort === undefined ? {} : { reasoningEffort: effort.effort } }
      const prompt = buildAuditorPrompt(answer, evidence.text, card)
      const started = runtime.now()
      let output: Awaited<ReturnType<typeof runAuditorCall>>
      try {
        output = await runAuditorCall(llm, {
          ...route,
          ...effort.effort === undefined ? {} : { reasoningEffort: effort.effort },
          maxTokens: config.auditorMaxTokens,
          temperature: config.auditorTemperature,
          system: prompt.system,
          user: prompt.user,
          signal,
        })
      } catch (error: unknown) {
        const latencyMs = Math.round(runtime.now() - started)
        const timedOut = timeout.aborted && !turnSignal.aborted
        const status = timedOut ? 'timeout' : 'error'
        const detail = timedOut ? `no verdict within ${String(config.maxLatencyMs)} ms` : describe(error)
        if (!(error instanceof AuditorCallError) || !turnSignal.aborted) {
          ctx.logger.warn(`second-angle: audit of turn ${String(turn)} failed open (${status}): ${detail}`)
        }
        const delivered = turnSignal.aborted && config.mode === 'sync' ? [] : scannerFallback(agent, turn, scan)
        record(agent.session, { ...base, status, source: delivered.length > 0 ? 'scanner' : 'none', detail, route: routeRecord, latencyMs, delivered })
        return
      }
      const latencyMs = Math.round(runtime.now() - started)
      const parsed = parseVerdict(output.text, evidence.text)
      if (parsed.kind === 'no-verdict') {
        ctx.logger.warn(`second-angle: the auditor gave no verdict for turn ${String(turn)} (${parsed.why}, finish ${output.finish})`)
        const delivered = scannerFallback(agent, turn, scan)
        record(agent.session, {
          ...base, status: 'no-verdict', source: delivered.length > 0 ? 'scanner' : 'none', detail: parsed.why,
          route: routeRecord, latencyMs, finish: output.finish, delivered,
        })
        return
      }
      const routing = routeVerdicts(parsed.claims, { steer: config.steer, requireQuoteForSteer: config.requireQuoteForSteer })
      const delivered: string[] = []
      let flagged: readonly ClaimVerdict[] = routing.flagged
      let status: VerdictRecord['status'] = routing.action === 'none' ? 'clean' : 'flagged'
      if (routing.contradicted.length > 0) {
        const correction = steerText(routing.contradicted, config.maxListedClaims)
        const turnOpen = config.mode === 'sync' && !turnSignal.aborted && !(recorders.get(agent.session)?.isClosed(turn) ?? true)
        if (turnOpen) {
          agent.steer(message(correction, steerSummary(routing.contradicted.length)))
          delivered.push('steer')
          status = 'steered'
        } else if (config.mode === 'async' && config.asyncContradicted === 'followup') {
          agent.followup(message(`Second angle on your answer in turn ${String(turn)}:\n${correction}`, steerSummary(routing.contradicted.length)))
          delivered.push('followup')
          status = 'steered'
        } else if (config.mode === 'async' && config.asyncContradicted === 'notice') {
          delivered.push(...deliverFlag(agent, turn, flagText(routing.contradicted, config.maxListedClaims), routing.contradicted.length, true))
        } else {
          // A cancelled or already-closed sync turn, or asyncContradicted=flag: the contradiction is flagged, never pushed.
          flagged = [...routing.contradicted, ...flagged]
        }
      }
      if (flagged.length > 0) delivered.push(...deliverFlag(agent, turn, flagText(flagged, config.maxListedClaims), flagged.length))
      if (status === 'clean') {
        ctx.logger.info(`second-angle: turn ${String(turn)} clean (${String(parsed.claims.length)} claims checked in ${String(latencyMs)} ms)`)
      }
      record(agent.session, {
        ...base, status, source: 'auditor', route: routeRecord, latencyMs, finish: output.finish,
        ...parsed.salvaged ? { detail: 'verdict salvaged from a malformed or cut-off output' } : {},
        claims: claimsSummary(parsed.claims), delivered: [...new Set(delivered)],
      })
    }

    /** Gate one stopping turn and audit it when it passes. */
    const onStopping = async (agent: Agent, turn: number, signal: AbortSignal): Promise<void> => {
      const session = agent.session
      if (!config.includeSubagents && isSubagent(session)) return
      const seen = audited.get(session) ?? new Set<number>()
      audited.set(session, seen)
      // The hook fires again with the same turn after a steered correction; a turn is audited once.
      if (seen.has(turn)) return
      seen.add(turn)
      const skip = (detail: string, scan?: ScanResult): void => {
        if (config.recordSkips) {
          record(session, { v: 1, turn, status: 'skipped', source: 'none', mode: config.mode, detail, ...scan === undefined ? {} : { scanner: scannerSummary(scan) }, delivered: [] })
        }
      }
      const turnRecord: TurnRecord | undefined = recorders.get(session)?.snapshot(turn)
      if (turnRecord === undefined) return skip('no-turn-state')
      const answer = turnRecord.finalText ?? ''
      if (turnRecord.finalInterrupted) return skip('interrupted')
      if (answer.trim().length < config.minAnswerChars) return skip('short-answer')
      const usedTool = turnRecord.tools.length > 0
      const evidence = renderEvidence(turnRecord.tools, config.maxEvidenceChars)
      const scan = scanAnswer(answer, usedTool ? evidence.text : '', scanOptions)
      if (!usedTool) {
        if (scan.absolutes.length === 0 && scan.numbers.length === 0) return skip('no-tool-no-markers', scan)
        if (config.memoryTurns === 'skip') return skip('memory-turn', scan)
        const findings: ScanFinding[] = [...scan.absolutes, ...config.flagMemoryNumbers ? scan.numbersNotInEvidence : []]
        if (findings.length === 0) return skip('memory-turn-numbers-only', scan)
        const delivered = deliverFlag(agent, turn, scannerFlagText(findings, config.maxListedClaims), findings.length)
        record(session, { v: 1, turn, status: 'flagged', source: 'scanner', mode: config.mode, detail: 'no tool ran in this turn; scanner only', scanner: scannerSummary(scan), delivered })
        return
      }
      if (scan.absolutes.length + scan.numbersNotInEvidence.length === 0 && evidence.sourceChars < config.minEvidenceChars) {
        return skip('scanner-clean-thin-evidence', scan)
      }
      const job = audit(agent, turn, answer, evidence, scan, signal).catch((error: unknown) => {
        ctx.logger.warn(`second-angle: audit of turn ${String(turn)} failed open: ${describe(error)}`)
      })
      inflight.add(job)
      void job.finally(() => { inflight.delete(job) })
      if (config.mode === 'sync') {
        // The audit's own signal enforces maxLatencyMs; this bound also holds when an adapter ignores the abort.
        let timer: ReturnType<typeof setTimeout> | undefined
        const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, config.maxLatencyMs + SYNC_GRACE_MS) })
        await Promise.race([job, bound])
        clearTimeout(timer)
      }
    }

    ctx.on('session/event', (session: Session, event: RecordedEvent) => {
      let recorder = recorders.get(session)
      if (recorder === undefined) {
        recorder = new TurnRecorder()
        recorders.set(session, recorder)
      }
      recorder.observe(event)
      if (event.type === 'turn/end') {
        const data = event.data as { turn?: unknown } | undefined
        if (typeof data?.turn === 'number') releaseNotices(session, data.turn)
      }
    })

    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
      try {
        await onStopping(agent, turn, signal)
      } catch (error: unknown) {
        // A throw from a serial listener would fail the turn; the second angle never does.
        ctx.logger.warn(`second-angle: turn ${String(turn)} not audited: ${describe(error)}`)
      }
    })
  }
}
