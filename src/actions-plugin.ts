/** Independent deterministic action audit and an optional monotonic pre-call guard. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { ActionRecorder } from './action-record.ts'
import { actionFlagText, redactActionText, scanActions, type ActionFinding, type ActionTurn } from './actions.ts'
import type { ResolvedConfig } from './config.ts'
import type { HarnessRuntime } from './plugin.ts'
import { boundSummary } from './messages.ts'

export const ACTIONS_RECORD_TYPE = 'plugin:second-angle/actions'

export interface ActionsRecord {
  readonly v: 1
  readonly turn: number
  readonly phase: 'before-call' | 'turn-end'
  readonly mode: 'flag' | 'block'
  readonly status: 'clean' | 'flagged' | 'blocked' | 'error'
  readonly findings: readonly ActionFinding[]
  readonly delivered: readonly string[]
  readonly detail?: string
}
export interface ActionsRuntime {
  readonly appendRecord: (session: Session, data: ActionsRecord) => void
  readonly createUserMessage: HarnessRuntime['createUserMessage']
  readonly writeDiagnostic: HarnessRuntime['writeDiagnostic']
}

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function redactFinding(finding: ActionFinding): ActionFinding {
  const redactCall = (call: ActionFinding['call']): ActionFinding['call'] => ({ ...call, arguments: redactActionText(call.arguments) })
  return {
    ...finding, call: redactCall(finding.call), reason: redactActionText(finding.reason),
    ...finding.relatedCall ? { relatedCall: redactCall(finding.relatedCall) } : {},
    ...finding.statement ? { statement: { ...finding.statement, text: redactActionText(finding.statement.text) } } : {},
  }
}

/** Mount only when actions are enabled; this module never reads ctx.llm. */
export function applyActions(ctx: Context, config: ResolvedConfig, runtime: ActionsRuntime): void {
  if (!config.enabled || config.actionsMode === 'off') return
  const mode = config.actionsMode
  const options = { allowedHosts: config.actionsAllowedHosts, toolRequirement: config.actionsToolRequirement }
  const recorders = new WeakMap<Session, ActionRecorder>()
  const agents = new WeakMap<Session, Agent>()
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'second-angle actions: cancel deferred publication')
  const recorderFor = (session: Session): ActionRecorder => {
    let recorder = recorders.get(session)
    if (!recorder) { recorder = new ActionRecorder(); recorders.set(session, recorder) }
    return recorder
  }
  const warn = (text: string): void => { ctx.logger.warn(`second-angle actions: ${redactActionText(text)}`) }
  const save = (session: Session, record: ActionsRecord): void => {
    if (!config.flagRecord) return
    try { runtime.appendRecord(session, { ...record, findings: record.findings.map(redactFinding) }) }
    catch (error: unknown) { warn(`could not record turn ${String(record.turn)}: ${describe(error)}`) }
  }
  const publish = (session: Session, turn: ActionTurn, phase: ActionsRecord['phase'], findings: readonly ActionFinding[]): void => {
    if (disposed) return
    const blocked = phase === 'before-call'
    const delivered = new Set<string>()
    const lines = findings.map(finding => actionFlagText(finding, turn.turn, blocked))
    for (const line of lines) {
      if (config.flagStderr) {
        try { runtime.writeDiagnostic(line); delivered.add('stderr') }
        catch (error: unknown) { warn(`diagnostic delivery failed: ${describe(error)}`) }
      }
      if (config.flagLog) { ctx.logger.warn(line); delivered.add('log') }
    }
    const noticeLines = findings.filter(finding => finding.severity === 'RED').map(finding => actionFlagText(finding, turn.turn))
    if (!blocked && config.flagNotice && noticeLines.length > 0) {
      const agent = agents.get(session)
      if (agent !== undefined) {
        try {
          agent.inject(runtime.createUserMessage({
            content: [{ type: 'text', text: noticeLines.join('\n') }],
            source: { kind: 'second-angle', form: 'notice', summary: boundSummary(`second angle ACTIONS: ${String(noticeLines.length)} flags`) },
          }))
          delivered.add('notice')
        } catch (error: unknown) { warn(`notice delivery failed: ${describe(error)}`) }
      }
    }
    save(session, { v: 1, turn: turn.turn, phase, mode, status: blocked ? 'blocked' : findings.length > 0 ? 'flagged' : 'clean', findings, delivered: [...delivered] })
  }

  ctx.on('agent/created', ({ agent }) => { agents.set(agent.session, agent) })
  ctx.on('agent/turn-stopping', ({ agent }) => { agents.set(agent.session, agent) })
  ctx.on('session/event', (session, event) => {
    const header = session.header
    const recorder = recorderFor(session)
    recorder.observe(event)
    if (event.type !== 'turn/end') return
    if (!config.includeSubagents && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) return
    const turn = recorder.snapshot()
    if (!turn || turn.turn !== event.data.turn || (turn.calls.length === 0 && !config.recordSkips)) return
    // Leave Session publication before appending records or injecting a notice.
    queueMicrotask(() => {
      if (disposed) return
      try { publish(session, turn, 'turn-end', scanActions(turn, options)) }
      catch (error: unknown) {
        const detail = `action scan failed: ${describe(error)}`
        warn(detail)
        save(session, { v: 1, turn: turn.turn, phase: 'turn-end', mode, status: 'error', findings: [], delivered: [], detail })
      }
    })
  })

  if (mode !== 'block') return
  // tools.guard owns an effect on this plugin context; disposing the plugin removes it.
  ctx.tools.guard((exec) => {
    const agent = exec.agent
    try {
      const recorder = agent === undefined ? undefined : recorderFor(agent.session)
      if (agent !== undefined) agents.set(agent.session, agent)
      const call = recorder?.addCall(exec.callId, exec.name, JSON.stringify(exec.arguments))
        ?? { callId: exec.callId, name: exec.name, arguments: JSON.stringify(exec.arguments), order: 1, status: 'requested' as const }
      const turn: ActionTurn = recorder?.snapshot() ?? { turn: 0, calls: [call], statements: [] }
      const findings = scanActions(turn, options).filter(finding => finding.call.callId === call.callId && finding.severity === 'RED' && finding.rule !== 'SAID-VS-DID')
      if (findings.length === 0) return undefined
      recorder?.markBlocked(call.callId)
      const blocked = findings.map(finding => ({ ...finding, call: { ...finding.call, status: 'blocked' as const } }))
      if (agent !== undefined) {
        // Denial is independent of delivery: a failed logger/record cannot allow the body.
        try { publish(agent.session, turn, 'before-call', blocked) } catch { /* the return below still denies */ }
      }
      return `second angle ACTIONS blocked ${JSON.stringify(call.callId)}: ${blocked.map(finding => `${finding.rule}: ${redactActionText(finding.reason)}`).join('; ')}`
    } catch (error: unknown) {
      return `second angle ACTIONS block mode could not inspect this call; denied: ${redactActionText(describe(error))}`
    }
  })
}
