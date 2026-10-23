/**
 * Public eval runner: sends every case in `eval/cases.jsonl` through the plugin's own auditor path
 * (renderEvidence → buildAuditorPrompt → runAuditorCall → parseVerdict → routeVerdicts, with the plugin's
 * default card, output cap, and temperature) against an OpenAI-compatible endpoint, and appends one JSON
 * line per call to the output file. The transport is a small HTTP client sending the same request fields
 * the harness pi-ai route sends for the auditor call; everything after the transport is the plugin's code.
 *
 * Usage (Node >= 22.18 runs this TypeScript file directly):
 *   node eval/run-eval.ts --base-url http://127.0.0.1:8000/v1 --model MODEL --efforts off,low --out eval/results/raw.jsonl
 * Options: --cases C1,K2 (subset)  --api-key KEY  --wait-health URL --max-busy 2 (wait while a local server is busy)
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { runAuditorCall, type AuditorLlm } from '../src/auditor.ts'
import { DEFAULTS } from '../src/config.ts'
import { renderEvidence } from '../src/evidence.ts'
import { buildAuditorPrompt } from '../src/prompt.ts'
import { routeVerdicts } from '../src/route.ts'
import { parseVerdict } from '../src/verdict.ts'

interface EvalCase {
  readonly id: string
  readonly kind: 'contradicted' | 'unsupported' | 'overstated' | 'clean'
  readonly source: string
  readonly tools: readonly { name: string; arguments: string; output: string }[]
  readonly answer: string
  readonly target: readonly string[]
}

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    model: { type: 'string' },
    'api-key': { type: 'string', default: 'none' },
    efforts: { type: 'string', default: 'off' },
    cases: { type: 'string' },
    out: { type: 'string', default: 'eval/results/raw.jsonl' },
    'wait-health': { type: 'string' },
    'max-busy': { type: 'string', default: '2' },
  },
})
const baseUrl = values['base-url']
const model = values.model
if (baseUrl === undefined || model === undefined) throw new Error('--base-url and --model are required')
const out = values.out
mkdirSync(dirname(out), { recursive: true })

/** Wire fields for one effort id, as the pi-ai `chat-template` route sends them (`off` sends thinking disabled). */
function templateKwargs(effort: string | undefined): Record<string, unknown> {
  if (effort === undefined || effort === 'off') return { enable_thinking: false }
  return { enable_thinking: true, reasoning_effort: effort }
}

let lastReasoningChars = 0

/** A minimal AuditorLlm over an OpenAI-compatible chat completions endpoint (non-streaming request, chunked replay). */
const llm: AuditorLlm = {
  resolveModelInfo: () => Promise.resolve({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } }),
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const user = options.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${values['api-key']}` },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'system', content: options.system ?? '' }, { role: 'user', content: user }],
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        stream: false,
        chat_template_kwargs: templateKwargs(options.reasoningEffort),
      }),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: `HTTP_${String(response.status)}`, message: await response.text() } } }
      return
    }
    const body = await response.json() as {
      choices: { message: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const choice = body.choices[0]
    lastReasoningChars = (choice?.message.reasoning_content ?? '').length
    const text = choice?.message.content ?? ''
    if (text.length > 0) yield { type: 'text-delta', index: 0, text }
    yield { type: 'usage', usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 } }
    yield { type: 'finish', reason: { kind: choice?.finish_reason === 'length' ? 'max-tokens' : 'stop' } }
  },
}

/** Wait while a local server reports more than `max-busy` active requests (polite sharing); no-op without --wait-health. */
async function waitForRoom(): Promise<void> {
  const url = values['wait-health']
  if (url === undefined) return
  const limit = Number(values['max-busy'])
  for (;;) {
    try {
      const health = await (await fetch(url)).json() as { inflight?: number; queued?: number; streams?: Record<string, number> }
      const streams = Object.entries(health.streams ?? {}).filter(([key]) => key !== 'max').reduce((sum, [, value]) => sum + (value || 0), 0)
      const busy = (health.inflight ?? 0) + (health.queued ?? 0) + streams
      if (busy <= limit) return
      console.log(`[${new Date().toTimeString().slice(0, 8)}] server busy (${String(busy)}); waiting 15 s`)
    } catch (error: unknown) {
      console.log(`health check failed (${String(error)}); waiting 15 s`)
    }
    await new Promise(resolve => setTimeout(resolve, 15_000))
  }
}

const cases: EvalCase[] = readFileSync(new URL('./cases.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as EvalCase)
const only = values.cases?.split(',')
const selected = only === undefined ? cases : cases.filter(item => only.includes(item.id))

for (const effort of values.efforts.split(',')) {
  for (const item of selected) {
    await waitForRoom()
    const evidence = renderEvidence(item.tools.map((tool, index) => ({ callId: `e${String(index)}`, ...tool, isError: false })), DEFAULTS.maxEvidenceChars)
    const prompt = buildAuditorPrompt(item.answer, evidence.text, DEFAULTS.card)
    const started = performance.now()
    let row: Record<string, unknown>
    try {
      const output = await runAuditorCall(llm, {
        provider: 'eval', model, ...effort === '' ? {} : { reasoningEffort: effort },
        maxTokens: DEFAULTS.auditorMaxTokens, temperature: DEFAULTS.auditorTemperature,
        system: prompt.system, user: prompt.user, signal: AbortSignal.timeout(600_000),
      })
      const seconds = (performance.now() - started) / 1000
      const parsed = parseVerdict(output.text, evidence.text)
      const routing = parsed.kind === 'verdict' ? routeVerdicts(parsed.claims, { steer: DEFAULTS.steer, requireQuoteForSteer: DEFAULTS.requireQuoteForSteer }) : undefined
      row = {
        id: item.id, kind: item.kind, effort, seconds: Math.round(seconds * 10) / 10, finish: output.finish,
        outputTokens: output.outputTokens, reasoningChars: lastReasoningChars,
        verdict: parsed.kind, ...parsed.kind === 'verdict' ? { salvaged: parsed.salvaged, claims: parsed.claims } : { why: parsed.why },
        action: routing?.action ?? 'none',
        contradicted: routing?.contradicted.map(claim => claim.claim) ?? [],
        flagged: routing?.flagged.map(claim => `${claim.label}: ${claim.claim}`) ?? [],
        target: item.target,
      }
    } catch (error: unknown) {
      row = { id: item.id, kind: item.kind, effort, seconds: Math.round((performance.now() - started) / 100) / 10, verdict: 'error', error: String(error), action: 'none', target: item.target }
    }
    appendFileSync(out, `${JSON.stringify(row)}\n`)
    console.log(`${item.id} ${item.kind} effort=${effort} ${String(row['seconds'])}s verdict=${String(row['verdict'])} action=${String(row['action'])}`)
  }
}
