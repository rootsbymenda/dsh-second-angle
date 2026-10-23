/**
 * Routes audited claims by severity: a contradiction backed by a verbatim
 * evidence quote steers a correction in the same turn; an overstated or
 * unsupported claim (and a contradiction the evidence does not visibly back)
 * becomes a flag. Supported claims produce nothing.
 * @module dsh-second-angle/route
 */

import type { ClaimVerdict } from './verdict.ts'

/** Routing switches from the plugin configuration. */
export interface RouteOptions {
  /** Whether a contradiction may steer a correction at all. */
  readonly steer: boolean
  /** Whether a contradiction must cite text that occurs in the evidence before it may steer. */
  readonly requireQuoteForSteer: boolean
}

/** What to do with one audited answer. */
export interface Routing {
  /** `steer` when at least one contradiction qualifies, else `flag` when anything is flagged, else `none`. */
  readonly action: 'none' | 'flag' | 'steer'
  /** Contradictions that qualify for a steered correction. */
  readonly contradicted: readonly ClaimVerdict[]
  /** Claims delivered as flags. */
  readonly flagged: readonly ClaimVerdict[]
}

/**
 * Route the verdicts of one answer.
 * @param claims - the auditor's verdicts.
 * @param options - routing switches.
 * @returns the action and the claims behind it.
 */
export function routeVerdicts(claims: readonly ClaimVerdict[], options: RouteOptions): Routing {
  const contradicted: ClaimVerdict[] = []
  const flagged: ClaimVerdict[] = []
  for (const claim of claims) {
    switch (claim.label) {
      case 'SUPPORTED':
        break
      case 'CONTRADICTED':
        if (options.steer && (claim.quoteFound || !options.requireQuoteForSteer)) contradicted.push(claim)
        else flagged.push(claim)
        break
      case 'OVERSTATED':
      case 'UNSUPPORTED':
        flagged.push(claim)
        break
    }
  }
  const action = contradicted.length > 0 ? 'steer' : flagged.length > 0 ? 'flag' : 'none'
  return { action, contradicted, flagged }
}
