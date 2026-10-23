/**
 * Parses the auditor's output into per-claim verdicts. Models wrap JSON in
 * prose or code fences, stop mid-object at the token cap, or print nothing;
 * each case has a defined outcome, and nothing here throws.
 * @module dsh-second-angle/verdict
 */

/** The four auditor labels. */
export type Label = 'SUPPORTED' | 'OVERSTATED' | 'UNSUPPORTED' | 'CONTRADICTED'

/** One audited claim. */
export interface ClaimVerdict {
  readonly claim: string
  readonly label: Label
  readonly reason: string
  /** The evidence text the auditor cited; absent for `NONE`. */
  readonly quote?: string
  /** Whether the cited text occurs in the evidence (whitespace, quote marks, and case normalized). */
  readonly quoteFound: boolean
}

/** The parse result: verdicts, or the reason no verdict was printed. */
export type ParseOutcome =
  | { readonly kind: 'verdict'; readonly claims: readonly ClaimVerdict[]; readonly salvaged: boolean }
  | { readonly kind: 'no-verdict'; readonly why: string }

const LABELS: ReadonlyMap<string, Label> = new Map<string, Label>([
  ['SUPPORTED', 'SUPPORTED'],
  ['OVERSTATED', 'OVERSTATED'],
  ['UNSUPPORTED', 'UNSUPPORTED'],
  ['NOT SUPPORTED', 'UNSUPPORTED'],
  ['CONTRADICTED', 'CONTRADICTED'],
])

/** Map a label as printed to one of the four, or `undefined`. */
export function normalizeLabel(value: unknown): Label | undefined {
  if (typeof value !== 'string') return undefined
  return LABELS.get(value.trim().toUpperCase().replace(/[\s_-]+/g, ' '))
}

/** Normalize text for the verbatim-quote check. */
function normalizeForQuote(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, '\'')
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Every balanced top-level `{...}` or `[...]` span in a text, string literals respected. */
function balancedSpans(text: string): string[] {
  const spans: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      if (depth > 0) inString = true
      continue
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = index
      depth += 1
    } else if ((char === '}' || char === ']') && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return spans
}

/** Read the `claims` array of one parsed JSON object, or `undefined`. */
function claimsMember(value: unknown): unknown[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const claims = (value as Record<string, unknown>)['claims']
  return Array.isArray(claims) ? claims : undefined
}

/** Convert raw claim objects into verdicts, dropping malformed ones. */
function toVerdicts(raw: readonly unknown[], evidence: string): ClaimVerdict[] {
  const normalizedEvidence = normalizeForQuote(evidence)
  const verdicts: ClaimVerdict[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const fields = item as Record<string, unknown>
    const label = normalizeLabel(fields['label'])
    const claim = typeof fields['claim'] === 'string' ? fields['claim'].trim() : ''
    if (label === undefined || claim.length === 0) continue
    const rawQuote = typeof fields['evidence_quote'] === 'string' ? fields['evidence_quote'].trim() : ''
    const hasQuote = rawQuote.length > 0 && rawQuote.toUpperCase() !== 'NONE'
    const normalizedQuote = hasQuote ? normalizeForQuote(rawQuote) : ''
    verdicts.push({
      claim,
      label,
      reason: typeof fields['reason'] === 'string' ? fields['reason'].trim() : '',
      ...hasQuote ? { quote: rawQuote } : {},
      quoteFound: hasQuote && normalizedQuote.length > 0 && normalizedEvidence.includes(normalizedQuote),
    })
  }
  return verdicts
}

/**
 * Parse one auditor output.
 * @param output - the text the auditor printed (its reasoning is never read).
 * @param evidence - the evidence text the auditor was given, for the quote check.
 * @returns the verdicts, or `no-verdict` with the reason.
 */
export function parseVerdict(output: string, evidence: string): ParseOutcome {
  const text = output.trim()
  if (text.length === 0) return { kind: 'no-verdict', why: 'the auditor printed nothing' }
  const unfenced = text.replace(/```(?:json)?/gi, '')
  // A bare array of claim objects is accepted only when no `{"claims": ...}` object is present.
  let bareArray: ClaimVerdict[] | undefined
  for (const span of balancedSpans(unfenced)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(span)
    } catch {
      // Not JSON (prose braces, or a cut-off object): try the next span, then salvage.
      continue
    }
    const raw = claimsMember(parsed)
    if (raw !== undefined) return { kind: 'verdict', claims: toVerdicts(raw, evidence), salvaged: false }
    if (Array.isArray(parsed) && bareArray === undefined) {
      const verdicts = toVerdicts(parsed, evidence)
      if (verdicts.length > 0) bareArray = verdicts
    }
  }
  if (bareArray !== undefined) return { kind: 'verdict', claims: bareArray, salvaged: false }
  // Salvage complete flat claim objects from a cut-off or malformed output.
  const salvaged: unknown[] = []
  for (const match of unfenced.matchAll(/\{[^{}]*"label"[^{}]*\}/g)) {
    try {
      salvaged.push(JSON.parse(match[0]))
    } catch {
      // A malformed fragment carries no verdict; the others may.
      continue
    }
  }
  const claims = toVerdicts(salvaged, evidence)
  if (claims.length > 0) return { kind: 'verdict', claims, salvaged: true }
  return { kind: 'no-verdict', why: 'no claims JSON found in the auditor output' }
}
