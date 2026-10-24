# dsh-second-angle

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives a finished turn a second
angle: it checks the answer's claims against the tool output that turn actually read, steers a correction when the
evidence contradicts a claim, and flags claims the evidence does not back.

## Why

On a private bench of our own sessions, a model auditor given the answer plus the tool output of its own turn, with
thinking off and a short facts-and-limits card, flagged all three known errors in a tool-using answer on 5 of 5
seeds (and, each time, one true claim the turn had not read), named the right reason for the hardest one on 5 of 5,
and needed about 16 seconds a check; with thinking on and the same card it was 7–11 times slower there and no more
accurate. A no-model scan for absolute words caught only the two errors that used
one, and on answers written without any tool read the same auditor flagged every claim, true or false. So the plugin
feeds the auditor the turn's own reads, keeps thinking off, never sends a turn without reads to the model, and puts
the free scan in front.

## Install

The plugin is a harness bundle (`"dsh": { "bundle": … }` in `package.json`). Install it into a profile:

```sh
# from a release tarball (prebuilt, no install-time build)
dsh plugin --profile <profile> add ./dsh-second-angle-0.1.0.tgz

# or from GitHub, pinned to a commit
dsh plugin --profile <profile> add github:rootsbymenda/dsh-second-angle#<commit>
```

A git install builds the plugin with its `prepare` script, and pnpm runs that only after you allow it: the first
`add` stops with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints the exact key to add under `allowBuilds` in the
profile's `pnpm-workspace.yaml` (for a git install the key is `dsh-second-angle@<the spec you gave>`); add it and run
the `add` again (see the harness guide *Package and install a plugin*). Check the result with
`dsh --profile <profile> --dump-config`: the tree shows a `# == dsh-second-angle` layer. Requires DeepSeek Harness
`>=0.2.1-rc.2 <0.3.0` (declared in `engines.dsh`).

## Configure

Every field is optional. Override them in your profile's `cordis.patch.yml` by restating the row (a patch replaces
the row's whole `config`):

```yaml
- id: second-angle
  config:
    mode: sync                 # sync | async
    maxLatencyMs: 45000
    auditorReasoningEffort: 'off'
    cardFile: /path/to/house-facts.txt   # one fact per line, appended to the card
    flagNotice: true
```

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `mode` | `sync` | `sync` waits for the verdict before the turn closes (so a contradiction can steer a correction in the same turn); `async` lets the turn close at once and attaches the verdict later |
| `maxLatencyMs` | `45000` | an audit that takes longer is abandoned; the turn goes on |
| `includeSubagents` | `false` | also audit sub-agent turns |
| `memoryTurns` | `scanner` | a turn that ran no tool never goes to the model; `scanner` reports its absolute words as a flag, `skip` leaves it alone |
| `flagMemoryNumbers` | `false` | in such a turn, also flag numeric claims |
| `minAnswerChars` | `20` | shorter answers are not audited |
| `minEvidenceChars` | `1` | when the scan finds nothing, call the model only if the turn read at least this much tool output |
| `auditorProvider`, `auditorModel` | the turn's own route | a separate auditor model (set both) |
| `auditorReasoningEffort` | `off` | sent only when the route offers that effort id; `''` sends none |
| `auditorMaxTokens` | `2048` | hard output cap of the auditor call |
| `auditorTemperature` | `0` | auditor sampling temperature |
| `maxEvidenceChars` | `48000` | longer tool output is shortened (head and tail kept, marked) |
| `card` | 8 general lines | facts-and-limits card; replaces the default |
| `cardFile` | — | file whose lines are appended to the card, read at load |
| `steer` | `true` | let a contradiction steer a correction |
| `requireQuoteForSteer` | `true` | steer only when the cited evidence text is found in the tool output |
| `maxListedClaims` | `3` | claims listed in one steering message or flag |
| `flagRecord` | `true` | write a `plugin:second-angle/verdict` record into the Session log |
| `flagStderr` | `true` | write each flag as one line on stderr (the headless CLI prints the answer on stdout, diagnostics on stderr) |
| `flagLog` | `true` | also write each flag as a warning through the harness logger |
| `flagNotice` | `false` | also inject each flag as a notice after the turn closes (see *How flags reach you*) |
| `asyncContradicted` | `notice` | async mode: a contradiction becomes a `notice`, a `followup` correction turn, or a plain `flag` |
| `recordSkips` | `false` | also record skipped turns and the gate that skipped them |
| `absoluteWords`, `extraUnits` | built in | scanner word list (replaces) and extra unit spellings (adds) |

## How it works

**The seam.** The harness dispatches `agent/turn-stopping` after the final step of a turn and before `turn/end`,
and awaits its listeners; a listener that objects calls `agent.steer(...)` and the loop runs another step in the
same turn. The event carries only `{ agent, turn, signal }`, so the plugin folds the turn's `tool/call`,
`tool/result`, and `assistant/message` events from `session/event` as they are committed.

**The gates**, in order:
1. Only the final step: the hook fires only there.
2. Only a turn that ran a tool, or whose answer has an absolute word or a numeric claim. A turn that ran no tool
   never reaches the model (an evidence-only auditor flags everything there); its absolute words become a scanner flag.
3. The free scanner: absolute words, plus numeric claims (numbers with units, version strings, ISO dates) that do not
   occur in the tool output. When it finds nothing and the turn read almost nothing, the model is not called.
4. One audit per turn: the hook fires again after a steered correction, and the same turn is never audited twice.

**The auditor** gets a fixed method prompt (list every factual claim; label each SUPPORTED, OVERSTATED, UNSUPPORTED,
or CONTRADICTED by three checks: what a count counts, whether an absolute word's range is covered, whether an
outside-world claim has a read in this turn), the facts-and-limits card, the answer, and the turn's own tool calls
with their full output. It runs with thinking off where the route offers it, a hard output cap, temperature 0, and
the closing order "Emit the JSON now." By default it uses the turn's own provider and model through `ctx.llm`; the
call is not written to the Session log. Output wrapped in prose or code fences, cut off at the cap, or empty is
handled: a usable verdict is salvaged, otherwise the turn is left alone.

**The routing.** A CONTRADICTED claim whose cited evidence text occurs in the tool output steers one short
correction message (a notice-form message, so the Web chat shows its one-line summary); the model revises in the
same turn. OVERSTATED and UNSUPPORTED claims, and contradictions whose quote is not found, become a flag. The
answer's text is never held back (it has already streamed); in `sync` mode the turn closes after the audit, within
`maxLatencyMs`. Every auditor error, timeout, or empty output fails open: the turn continues unchanged and the failure
is logged and recorded.

### How flags reach you

- **Session record** (default on): a `plugin:second-angle/verdict` record per audited turn, an ignorable plugin record
  that fork and resume carry and that readers without the plugin skip. It holds the status, the route, the latency,
  the scanner findings, and every claim with its label, reason, and quote.
- **stderr** (default on): one line per flag, for example
  `second angle: 1 claim not backed by this turn's reads: (1) "…" (OVERSTATED: …) [turn 1]`. With
  `dsh --profile headless` the answer goes to stdout and this line to stderr, right after it.
- **Harness logger** (default on): the same line as a warning through `ctx.logger`, for hosts that export their logs.
- **Notice** (`flagNotice: true`): the same line injected after the turn closes. It reaches the model with the next
  turn, and the Web chat shows its summary row then. It is not injected during the turn: an injected message at the
  stop boundary would force another step.

## Public eval

See [`eval/`](eval/README.md): 24 cases built from verbatim excerpts of the harness's own documentation (8
contradicted, 8 unsupported or overstated, 8 clean controls on the same evidence), run through the plugin's own
auditor path. Results and every failure: [`eval/EVAL_RESULTS.md`](eval/EVAL_RESULTS.md).

With thinking off (the default), on DeepSeek V4.1 Flash served locally:

| contradicted: steered | contradicted: acted on | unsupported or overstated: flagged | clean: false flags | no verdict | median per audit |
|---|---|---|---|---|---|
| 7/8 | 8/8 | 8/8 | 0/8 | 0/24 | 3.6 s |

The one contradiction that was not steered (C7) came back OVERSTATED, with the right reason, and was flagged. The set
is small and written by us, and the default card speaks to three of its cases; the results file says what the
numbers do and do not show.

With `auditorReasoningEffort: low` (short thinking) the same set gave 8/8 steered, 8/8 flagged, 0/8 false flags,
and no missing verdicts, at a median of 5.85 s per audit (1.6 times longer). It also steered once on a sentence we had
written as true but which did overstate its evidence.

## Limits

- **The answer has already streamed.** By the time `agent/turn-stopping` fires, the user has seen the text. A steer
  produces a visible revision in the same turn; a flag cannot unsay anything.
- **It shares the model.** By default the auditor is one more call to the same model: in `sync` mode the turn closes
  later by the audit time (2–3 seconds per audit in our integration runs with thinking off, bounded by
  `maxLatencyMs`), and it adds load to a shared server. Use `async`, a separate `auditorModel`, or a higher
  `minEvidenceChars` to trade coverage for latency.
- **The stock Web chat does not render plugin records.** Flags live in the Session log, on stderr, and in the harness
  logger, and with `flagNotice` in the chat one turn later. A client renderer for the record is the obvious next step.
- **Only this turn's reads count as evidence.** The auditor sees nothing else, so a claim the model knows from an
  earlier turn or from memory has nothing to stand on and gets flagged (on our bench, one such true claim was flagged
  every time); it may well be true. Treat such flags as "not checked this turn".
- **The card matters, and it is not magic.** The bench showed the auditor uses a fact on its card reliably; it did not
  show help on a mistake whose fact is not on the card. The default card is general; a house card that gains one line
  per real mistake works best.
- **The auditor reads untrusted tool output.** A crafted output can bias its verdict, and a steering message carries
  the auditor's one-line reason. Steering fires only on a contradiction whose cited text occurs in the tool output.
- **The scanner is English-only** and misses spelled-out numbers ("four").
- **Long tool output is shortened** past `maxEvidenceChars`; the record says when.
- **Async mode cannot steer**: the turn is closed by then; a contradiction becomes a notice (or a follow-up turn).
- Built and tested against DeepSeek Harness 0.2.1-rc.2 only; harness APIs are pre-stable.

## Development

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm test   # tsc strict, oxlint, vitest
pnpm run build                                     # lib/
```

The tests include full-loop runs on the published harness agent loop with scripted models: a steered correction in
the same turn, one audit per turn, flags without an extra step, the gates, fail-open on prose, provider errors and
timeouts, notices delivered after the turn closes, and async mode.

Prepared with AI assistance; reproduced and tested locally.

## License

MIT — see [LICENSE](LICENSE). DeepSeek Harness is © 2026 DeepSeek, MIT License.
