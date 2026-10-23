import { describe, expect, it } from 'vitest'
import { DEFAULTS, resolveConfig } from '../src/config.ts'
import { renderEvidence } from '../src/evidence.ts'
import { boundSummary, flagText, noticeSummary, scannerFlagText, steerSummary, steerText, SUMMARY_MAX_CHARS } from '../src/messages.ts'
import { buildAuditorPrompt, DEFAULT_CARD } from '../src/prompt.ts'
import { routeVerdicts } from '../src/route.ts'
import type { ClaimVerdict } from '../src/verdict.ts'

const v = (label: ClaimVerdict['label'], quoteFound = false, claim = 'c'): ClaimVerdict =>
  ({ claim, label, reason: 'why', ...quoteFound ? { quote: 'q' } : {}, quoteFound })

describe('routeVerdicts', () => {
  const on = { steer: true, requireQuoteForSteer: true }
  it('steers on a contradiction that cites evidence, and flags the rest', () => {
    const routing = routeVerdicts([v('CONTRADICTED', true), v('UNSUPPORTED'), v('SUPPORTED'), v('OVERSTATED')], on)
    expect(routing.action).toBe('steer')
    expect(routing.contradicted).toHaveLength(1)
    expect(routing.flagged.map(c => c.label)).toEqual(['UNSUPPORTED', 'OVERSTATED'])
  })
  it('flags a contradiction whose quote is not in the evidence, unless the quote rule is off', () => {
    expect(routeVerdicts([v('CONTRADICTED', false)], on).action).toBe('flag')
    expect(routeVerdicts([v('CONTRADICTED', false)], { steer: true, requireQuoteForSteer: false }).action).toBe('steer')
  })
  it('never steers when steering is off', () => {
    const routing = routeVerdicts([v('CONTRADICTED', true)], { steer: false, requireQuoteForSteer: true })
    expect(routing).toMatchObject({ action: 'flag', contradicted: [] })
  })
  it('does nothing when every claim is supported or there are none', () => {
    expect(routeVerdicts([v('SUPPORTED')], on).action).toBe('none')
    expect(routeVerdicts([], on).action).toBe('none')
  })
})

describe('messages', () => {
  it('keeps every notice summary within the harness bound', () => {
    for (const summary of [steerSummary(1), steerSummary(12), noticeSummary(3), boundSummary('x'.repeat(500))]) {
      expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS)
    }
  })
  it('names the claim, the evidence, and the instruction in the steering text', () => {
    const text = steerText([{ claim: 'it has 3 entries', label: 'CONTRADICTED', reason: 'output shows 4', quote: 'entries: 4', quoteFound: true }], 3)
    expect(text).toContain('You wrote: "it has 3 entries"')
    expect(text).toContain('The tool output shows: "entries: 4"')
    expect(text).toContain('Correct the answer now')
  })
  it('lists at most maxClaims claims and counts the rest', () => {
    const line = flagText([v('UNSUPPORTED', false, 'a'), v('OVERSTATED', false, 'b'), v('UNSUPPORTED', false, 'c')], 2)
    expect(line).toMatch(/^second angle: 3 claims not backed by this turn's reads: \(1\) "a" \(UNSUPPORTED: why\); \(2\) "b"/)
    expect(line).toContain('(+1 more)')
    expect(scannerFlagText([{ kind: 'absolute-word', match: 'never', sentence: 'It never fails.' }], 3))
      .toBe('second angle: 1 claim with no read in this turn to back them: (1) "It never fails." (absolute word "never")')
  })
})

describe('resolveConfig', () => {
  it('applies the defaults', () => {
    expect(resolveConfig({})).toEqual(DEFAULTS)
    expect(resolveConfig().auditorReasoningEffort).toBe('off')
  })
  it('fails loud on invalid values', () => {
    expect(() => resolveConfig({ maxLatencyMs: 0 })).toThrow(/maxLatencyMs/)
    expect(() => resolveConfig({ auditorMaxTokens: 1.5 })).toThrow(/auditorMaxTokens/)
    expect(() => resolveConfig({ auditorTemperature: 3 })).toThrow(/auditorTemperature/)
    expect(() => resolveConfig({ mode: 'later' as 'sync' })).toThrow(/mode/)
    expect(() => resolveConfig({ auditorProvider: 'p' })).toThrow(/set together/)
  })
  it('treats blank optional text as absent', () => {
    expect(resolveConfig({ auditorProvider: ' ', auditorModel: '' }).auditorProvider).toBeUndefined()
    expect(resolveConfig({ auditorReasoningEffort: ' ' }).auditorReasoningEffort).toBe('')
  })
})

describe('renderEvidence and buildAuditorPrompt', () => {
  it('renders every call with its arguments and full output under the cap', () => {
    const evidence = renderEvidence([{ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}', output: 'a\nb', isError: false }], 1000)
    expect(evidence).toMatchObject({ truncated: false, tools: 1, sourceChars: 3 })
    expect(evidence.text).toContain('[tool 1] bash {"command":"ls"}')
    expect(evidence.text).toContain('a\nb')
  })
  it('keeps small outputs whole and shortens large ones over the cap', () => {
    const big = 'x'.repeat(5000)
    const evidence = renderEvidence([
      { callId: 'a', name: 't', arguments: '', output: 'small', isError: false },
      { callId: 'b', name: 't', arguments: '', output: big, isError: true },
    ], 1000)
    expect(evidence.truncated).toBe(true)
    expect(evidence.text).toContain('small')
    expect(evidence.text).toContain('characters omitted by second-angle')
    expect(evidence.text).toContain('(the tool reported an error)')
    expect(evidence.text.length).toBeLessThan(1400)
  })
  it('puts the method and the card in the system prompt and ends the user message with the emit order', () => {
    const prompt = buildAuditorPrompt('answer text', 'evidence text', DEFAULT_CARD)
    expect(prompt.system).toContain('FACTS AND LIMITS CARD')
    expect(prompt.system).toContain(DEFAULT_CARD[0])
    expect(prompt.user).toContain('answer text')
    expect(prompt.user).toContain('evidence text')
    expect(prompt.user.endsWith('Emit the JSON now.')).toBe(true)
    expect(buildAuditorPrompt('a', 'e', []).system).not.toContain('FACTS AND LIMITS CARD')
  })
})
