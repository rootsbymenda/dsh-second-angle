/**
 * The free scanner: a no-model pass over a finished answer. It finds absolute
 * words ("every", "never", "nobody", ...) and numeric claims (numbers that
 * carry a unit, version strings, and dates), and reports which numeric claims
 * do not appear anywhere in the turn's tool output. It runs in well under a
 * millisecond and decides whether the model auditor is worth calling at all.
 * @module dsh-second-angle/scanner
 */

/** One scanner hit: what matched and the sentence it sits in. */
export interface ScanFinding {
  /** `absolute-word`: a word asserting a whole range; `number-not-in-evidence`: a numeric claim absent from the tool output. */
  readonly kind: 'absolute-word' | 'number-not-in-evidence'
  /** The matched text, as written in the answer. */
  readonly match: string
  /** The answer sentence containing the match, trimmed and capped at 240 characters. */
  readonly sentence: string
}

/** Everything the scanner learned about one answer. */
export interface ScanResult {
  /** Absolute words found in the answer, in order of appearance. */
  readonly absolutes: readonly ScanFinding[]
  /** Numeric claims whose value does not occur in the evidence text. */
  readonly numbersNotInEvidence: readonly ScanFinding[]
  /** Every numeric claim in the answer (numbers with a unit, version strings, dates), whether or not the evidence has it. */
  readonly numbers: readonly string[]
}

/** Scanner options; both lists come from the plugin configuration. */
export interface ScanOptions {
  /** Absolute words and phrases, matched case-insensitively on word boundaries. */
  readonly absoluteWords: readonly string[]
  /** Extra unit spellings appended to the built-in list. */
  readonly extraUnits?: readonly string[]
}

/** The default absolute words: the range check of the auditor prompt plus a few common totalizers. */
export const DEFAULT_ABSOLUTE_WORDS: readonly string[] = [
  'every', 'always', 'never', 'nobody', 'no one', 'none', 'all', 'only', 'since',
  'everyone', 'everything', 'nothing', 'entire', 'entirely', 'guaranteed', 'impossible',
]

/**
 * Unit spellings recognised after a number. Single letters that are also
 * ordinary words are deliberately absent; `k`, `K`, and `M` only count when
 * attached to the digits (`10k`, `1M`).
 */
const BUILTIN_UNITS: readonly string[] = [
  'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'KB', 'kB', 'MB', 'GB', 'TB', 'PB', 'bytes', 'byte', 'B',
  'ns', 'µs', 'us', 'ms', 'seconds', 'second', 'secs', 'sec', 's', 'minutes', 'minute', 'mins', 'min',
  'hours', 'hour', 'hrs', 'hr', 'h', 'days', 'day', 'weeks', 'week', 'months', 'month', 'years', 'year',
  '%', '×', 'x', 'tok/s', 'tokens', 'token', 'lines', 'line', 'files', 'file', 'entries', 'entry',
  'rows', 'row', 'records', 'record', 'requests', 'request', 'calls', 'call', 'commits', 'commit',
  'tests', 'test', 'errors', 'error', 'warnings', 'warning', 'items', 'item', 'issues', 'issue',
  'PRs', 'PR', 'steps', 'step', 'chars', 'characters', 'words', 'pages', 'page', 'times',
  'GHz', 'MHz', 'kHz', 'Hz', 'kW', 'rpm', 'rps', 'qps', 'fps', 'dpi', 'px', '°C', '°F',
]

/** Escape one literal for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Normalize a numeric literal so `1,024`, `1024`, and `1024.0` compare equal. */
export function normalizeNumber(literal: string): string {
  const plain = literal.replace(/[,  ]/g, '')
  if (!plain.includes('.')) return plain.replace(/^0+(?=\d)/, '')
  const [whole = '0', fraction = ''] = plain.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  const head = whole.replace(/^0+(?=\d)/, '')
  return trimmed.length === 0 ? head : `${head}.${trimmed}`
}

/** Every number written in a text, normalized. */
function numbersIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    found.add(normalizeNumber(match[0]))
  }
  return found
}

/** The sentence around one character index, capped for records and messages. */
function sentenceAt(text: string, index: number): string {
  const before = text.slice(0, index)
  const startCandidates = [before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf('\n')]
  const start = Math.max(...startCandidates) + 1
  const rest = text.slice(index)
  const endMatch = /[.!?](\s|$)|\n/.exec(rest)
  const end = endMatch === null ? text.length : index + endMatch.index + 1
  const sentence = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return sentence.length > 240 ? `${sentence.slice(0, 239)}…` : sentence
}

/** Build the number-with-unit pattern for one unit list. */
function numberWithUnitPattern(extraUnits: readonly string[]): RegExp {
  const units = [...BUILTIN_UNITS, ...extraUnits]
    .filter(unit => unit.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
  const number = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`
  // A spaced or attached unit ends at a non-word character; `k`/`K`/`M` must be attached.
  return new RegExp(String.raw`(?<![\w.,])${number}(?:\s?(${units.join('|')})|([kKM]))(?![\p{L}\p{N}_])`, 'gu')
}

/** Version strings (`2.4.1`, `v0.2.1-rc.2`) and ISO dates (`2026-09-30`), compared as written. */
const LITERAL_PATTERN = /(?<![\w.])(?:v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?|\d{4}-\d{2}-\d{2})(?![\w])/g

/** Build the absolute-word pattern for one word list. */
function absolutePattern(words: readonly string[]): RegExp | undefined {
  const cleaned = words.map(word => word.trim()).filter(word => word.length > 0)
  if (cleaned.length === 0) return undefined
  const alternatives = cleaned
    .sort((a, b) => b.length - a.length)
    .map(word => escapeRegExp(word).replace(/\s+/g, String.raw`\s+`))
  return new RegExp(String.raw`(?<![\p{L}\p{N}_'])(?:${alternatives.join('|')})(?![\p{L}\p{N}_'])`, 'giu')
}

/**
 * Scan one answer against the evidence text of its turn.
 * @param answer - the final assistant text of the turn.
 * @param evidence - the turn's tool output, as one text; empty for a turn that used no tool.
 * @param options - absolute words and extra units.
 * @returns absolute words, numbers with units, and the numbers the evidence does not contain.
 */
export function scanAnswer(answer: string, evidence: string, options: ScanOptions): ScanResult {
  const absolutes: ScanFinding[] = []
  const pattern = absolutePattern(options.absoluteWords)
  if (pattern !== undefined) {
    for (const match of answer.matchAll(pattern)) {
      absolutes.push({ kind: 'absolute-word', match: match[0], sentence: sentenceAt(answer, match.index) })
    }
  }
  const known = numbersIn(evidence)
  const numbers: string[] = []
  const numbersNotInEvidence: ScanFinding[] = []
  for (const match of answer.matchAll(numberWithUnitPattern(options.extraUnits ?? []))) {
    const literal = match[1] ?? ''
    numbers.push(match[0])
    if (!known.has(normalizeNumber(literal))) {
      numbersNotInEvidence.push({ kind: 'number-not-in-evidence', match: match[0], sentence: sentenceAt(answer, match.index) })
    }
  }
  for (const match of answer.matchAll(LITERAL_PATTERN)) {
    numbers.push(match[0])
    if (!evidence.includes(match[0].replace(/^v/, ''))) {
      numbersNotInEvidence.push({ kind: 'number-not-in-evidence', match: match[0], sentence: sentenceAt(answer, match.index) })
    }
  }
  return { absolutes, numbersNotInEvidence, numbers }
}
