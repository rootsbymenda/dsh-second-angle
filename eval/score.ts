/**
 * Score a raw eval file written by run-eval.ts. Per reasoning effort it reports:
 * - contradicted cases: how many the plugin would STEER on (a contradiction with a verified quote naming the
 *   planted claim) and how many it would act on at all (steer or flag on the planted claim);
 * - unsupported / overstated cases: how many it would flag (or steer) on the planted claim;
 * - clean controls: false flags (any action at all);
 * - no-verdict rate (the auditor printed no usable JSON, or the call failed) and median seconds per call.
 * A case's planted claim is matched by its `target` keywords (case-insensitive) against the flagged claim text.
 * Usage: node eval/score.ts eval/results/raw.jsonl
 */
import { readFileSync } from 'node:fs'

interface Row {
  id: string
  kind: 'contradicted' | 'unsupported' | 'overstated' | 'clean'
  effort: string
  seconds: number
  verdict: string
  action: 'none' | 'flag' | 'steer'
  contradicted?: string[]
  flagged?: string[]
  target: string[]
}

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node eval/score.ts <raw.jsonl>')
const rows: Row[] = readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Row)

/** Whether any of the claims names the planted claim. */
function names(claims: readonly string[] | undefined, target: readonly string[]): boolean {
  return (claims ?? []).some(claim => target.some(word => claim.toLowerCase().includes(word.toLowerCase())))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return Number.NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] ?? Number.NaN : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

const efforts = [...new Set(rows.map(row => row.effort))]
console.log('| effort | contradicted: steered | contradicted: acted on | unsupported: flagged | overstated: flagged | clean: false flags | no verdict | median s |')
console.log('|---|---|---|---|---|---|---|---|')
for (const effort of efforts) {
  const mine = rows.filter(row => row.effort === effort)
  const of = (kind: Row['kind']) => mine.filter(row => row.kind === kind)
  const contradicted = of('contradicted')
  const steered = contradicted.filter(row => row.action === 'steer' && names(row.contradicted, row.target)).length
  const actedOn = contradicted.filter(row => names([...row.contradicted ?? [], ...row.flagged ?? []], row.target)).length
  const flaggedOn = (kind: Row['kind']) => of(kind).filter(row => names([...row.contradicted ?? [], ...row.flagged ?? []], row.target)).length
  const clean = of('clean')
  const falseFlags = clean.filter(row => row.action !== 'none').length
  const noVerdict = mine.filter(row => row.verdict !== 'verdict').length
  console.log(`| ${effort} | ${String(steered)}/${String(contradicted.length)} | ${String(actedOn)}/${String(contradicted.length)} | ${String(flaggedOn('unsupported'))}/${String(of('unsupported').length)} | ${String(flaggedOn('overstated'))}/${String(of('overstated').length)} | ${String(falseFlags)}/${String(clean.length)} | ${String(noVerdict)}/${String(mine.length)} | ${median(mine.map(row => row.seconds)).toFixed(1)} |`)
}
console.log('\nPer case (effort: action, planted claim named?):')
for (const id of new Set(rows.map(row => row.id))) {
  const parts = rows.filter(row => row.id === id).map((row) => {
    const named = row.kind === 'clean' ? '' : names([...row.contradicted ?? [], ...row.flagged ?? []], row.target) ? ' (named)' : ' (missed)'
    return `${row.effort}: ${row.verdict === 'verdict' ? row.action : row.verdict}${named} ${String(row.seconds)}s`
  })
  console.log(`${id} [${rows.find(row => row.id === id)?.kind ?? ''}] ${parts.join(' | ')}`)
}
