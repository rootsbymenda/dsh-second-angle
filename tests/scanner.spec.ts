import { describe, expect, it } from 'vitest'
import { DEFAULT_ABSOLUTE_WORDS, normalizeNumber, scanAnswer } from '../src/scanner.ts'

const options = { absoluteWords: DEFAULT_ABSOLUTE_WORDS }

describe('scanAnswer: absolute words', () => {
  it('finds absolute words on word boundaries, case-insensitively, with their sentence', () => {
    const result = scanAnswer('The cache is warm. Nobody has measured it. It always restarts.', '', options)
    expect(result.absolutes.map(finding => finding.match)).toEqual(['Nobody', 'always'])
    expect(result.absolutes[0]?.sentence).toBe('Nobody has measured it.')
  })

  it('matches a multi-word phrase and ignores words that only contain an absolute word', () => {
    const result = scanAnswer('No one ran it. The allocator is small; overall it is fine.', '', options)
    expect(result.absolutes.map(finding => finding.match)).toEqual(['No one'])
  })

  it('uses the configured list, and an empty list finds nothing', () => {
    expect(scanAnswer('It never fails.', '', { absoluteWords: ['fails'] }).absolutes.map(f => f.match)).toEqual(['fails'])
    expect(scanAnswer('It never fails.', '', { absoluteWords: [] }).absolutes).toEqual([])
  })
})

describe('scanAnswer: numbers with units', () => {
  it('finds numbers with units and reports the ones the evidence does not contain', () => {
    const result = scanAnswer('The store holds 1,326 files in 185 GiB and took 16 s.', 'total 1326\n189518 MiB', options)
    expect(result.numbersWithUnit).toEqual(['1,326 files', '185 GiB', '16 s'])
    expect(result.numbersNotInEvidence.map(finding => finding.match)).toEqual(['185 GiB', '16 s'])
  })

  it('accepts attached k/M/x suffixes and percent signs', () => {
    const result = scanAnswer('About 10k tokens, 1M context, 3x faster, 42% done.', '', options)
    expect(result.numbersWithUnit).toEqual(['10k', '1M', '3x', '42%'])
  })

  it('does not treat a bare number or a version as a number with a unit', () => {
    const result = scanAnswer('Python 3 is installed; see section 2.1 and issue #60.', '', options)
    expect(result.numbersWithUnit).toEqual([])
  })

  it('accepts extra unit spellings from the configuration', () => {
    const result = scanAnswer('It used 12 shards.', '', { absoluteWords: [], extraUnits: ['shards'] })
    expect(result.numbersWithUnit).toEqual(['12 shards'])
  })
})

describe('normalizeNumber', () => {
  it('drops thousands separators, leading zeros, and trailing fraction zeros', () => {
    expect(normalizeNumber('1,024')).toBe('1024')
    expect(normalizeNumber('007')).toBe('7')
    expect(normalizeNumber('2.50')).toBe('2.5')
    expect(normalizeNumber('2.0')).toBe('2')
  })
})
