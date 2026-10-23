import { describe, expect, it } from 'vitest'
import { normalizeLabel, parseVerdict } from '../src/verdict.ts'

const evidence = 'entries: 4\nbuild: passed\nsize 189518 MiB'
const claim = (label: string, quote = 'NONE') => ({ claim: 'the file lists 3 entries', evidence_quote: quote, label, reason: 'r' })

describe('parseVerdict', () => {
  it('reads a strict JSON verdict and checks each quote against the evidence', () => {
    const output = JSON.stringify({ claims: [claim('CONTRADICTED', 'entries: 4'), claim('UNSUPPORTED', 'entries: 7')] })
    const parsed = parseVerdict(output, evidence)
    expect(parsed.kind).toBe('verdict')
    if (parsed.kind !== 'verdict') return
    expect(parsed.salvaged).toBe(false)
    expect(parsed.claims.map(c => [c.label, c.quoteFound])).toEqual([['CONTRADICTED', true], ['UNSUPPORTED', false]])
  })

  it('reads a verdict wrapped in prose and a code fence', () => {
    const output = `Here is my audit:\n\n\`\`\`json\n${JSON.stringify({ claims: [claim('SUPPORTED', 'build: passed')] })}\n\`\`\`\nDone.`
    const parsed = parseVerdict(output, evidence)
    expect(parsed).toMatchObject({ kind: 'verdict', claims: [{ label: 'SUPPORTED', quoteFound: true }] })
  })

  it('is not fooled by a bracketed number in the prose before the JSON', () => {
    const output = `See [1] and {not json}. ${JSON.stringify({ claims: [claim('OVERSTATED')] })}`
    expect(parseVerdict(output, evidence)).toMatchObject({ kind: 'verdict', claims: [{ label: 'OVERSTATED' }] })
  })

  it('returns no-verdict for an empty output and for prose without JSON', () => {
    expect(parseVerdict('', evidence)).toEqual({ kind: 'no-verdict', why: 'the auditor printed nothing' })
    expect(parseVerdict('   \n', evidence).kind).toBe('no-verdict')
    expect(parseVerdict('I think every claim is fine.', evidence).kind).toBe('no-verdict')
  })

  it('salvages complete claim objects from an output cut off at the token cap', () => {
    const cut = `{"claims":[${JSON.stringify(claim('CONTRADICTED', 'entries: 4'))},{"claim":"the build pas`
    const parsed = parseVerdict(cut, evidence)
    expect(parsed).toMatchObject({ kind: 'verdict', salvaged: true, claims: [{ label: 'CONTRADICTED', quoteFound: true }] })
  })

  it('accepts a bare array of claim objects and an empty claims list', () => {
    expect(parseVerdict(JSON.stringify([claim('UNSUPPORTED')]), evidence)).toMatchObject({ kind: 'verdict', claims: [{ label: 'UNSUPPORTED' }] })
    expect(parseVerdict('{"claims":[]}', evidence)).toEqual({ kind: 'verdict', claims: [], salvaged: false })
  })

  it('drops claims with an unknown label or no claim text, and treats NONE as no quote', () => {
    const output = JSON.stringify({ claims: [claim('MAYBE'), { claim: '', label: 'SUPPORTED' }, claim('unsupported', 'none')] })
    const parsed = parseVerdict(output, evidence)
    if (parsed.kind !== 'verdict') throw new Error('expected a verdict')
    expect(parsed.claims).toHaveLength(1)
    expect(parsed.claims[0]).toMatchObject({ label: 'UNSUPPORTED', quoteFound: false })
    expect(parsed.claims[0]?.quote).toBeUndefined()
  })

  it('normalizes whitespace, curly quotes, and case in the quote check', () => {
    const output = JSON.stringify({ claims: [claim('CONTRADICTED', '  ENTRIES:   4 ')] })
    expect(parseVerdict(output, evidence)).toMatchObject({ kind: 'verdict', claims: [{ quoteFound: true }] })
  })
})

describe('normalizeLabel', () => {
  it('maps spellings to the four labels', () => {
    expect(normalizeLabel(' supported ')).toBe('SUPPORTED')
    expect(normalizeLabel('NOT_SUPPORTED')).toBe('UNSUPPORTED')
    expect(normalizeLabel('Contradicted')).toBe('CONTRADICTED')
    expect(normalizeLabel('wrong')).toBeUndefined()
    expect(normalizeLabel(3)).toBeUndefined()
  })
})
