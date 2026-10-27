# dsh-second-angle

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives a finished turn a second
angle: it checks the answer's claims against the tool output that turn actually read, steers a correction when the
evidence contradicts a claim, and flags claims the evidence does not back.

Version 0.2 also checks the turn's **actions** with deterministic patterns: tool requests, exposed reasoning and
visible text. ACTIONS makes no model calls. It reports by default, with opt-in blocking for RED patterns before a
tool runs. The existing claim auditor remains enabled by default; set `claimsEnabled: false` for an entirely
model-free check.

## Why

We tested the method on a private bench of our own sessions. The bench held one answer that used tools, with three
known errors and three true claims. The auditor saw it together with that turn's own tool output. With thinking off
and a short facts-and-limits card, it flagged all three errors in 5 of 5 runs (five sampling seeds at temperature
0.7). Each run also flagged one true claim that the turn had not read. It named the right reason for the hardest
error in 5 of 5. A check took about 16 seconds. With short thinking on and the same card, it was about 9–11 times
slower and no more accurate.

A scan for absolute words, with no model, caught only the two errors that used one. On answers written without any
tool read, an auditor that sees only evidence flagged every claim, true or false. So the plugin feeds the auditor
the turn's own reads, keeps thinking off, puts the free scan in front, and never sends a turn without reads to the
model.

## Install

The plugin is a harness bundle (`"dsh": { "bundle": … }` in `package.json`). Install it into a profile. The examples
use the shipped `headless` profile, which runs one task from the command line; another profile name gets the base
layers and the plugin only. If you run the harness through `npx @deepseek-ai/dsh`, type that in place of `dsh`.
`dsh plugin` uses the pnpm on your PATH.

```sh
# from the release tarball (prebuilt, no build)
curl -LO https://github.com/rootsbymenda/dsh-second-angle/releases/download/v0.2.1/dsh-second-angle-0.2.1.tgz
dsh plugin --profile headless add ./dsh-second-angle-0.2.1.tgz

# or from GitHub, pinned to a commit
dsh plugin --profile headless add github:rootsbymenda/dsh-second-angle#<commit>
```

A git install builds the plugin with its `prepare` script (`tsc -p tsconfig.build.json`, which writes `lib/`), and
pnpm runs that only after you allow it: the first `add` stops with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints
the key to add under `allowBuilds` in the profile's `pnpm-workspace.yaml`. For a GitHub install the key has this
form, where `<commit>` is the full 40-character commit pnpm resolved:

```yaml
allowBuilds:
  dsh-second-angle@https://codeload.github.com/rootsbymenda/dsh-second-angle/tar.gz/<commit>: true
```

pnpm prints the key on one long line, and a terminal narrower than the line wraps it; if it breaks across lines, join
the pieces with no space. A bare package name does not approve a git dependency (the example in the harness guide
[*Installing from GitHub*](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/publish.md#installing-from-github-the-build-script-catch)
uses one). Add the key and run the same `add` again. The `add` warns about peer dependencies (the running harness
provides them), and a git install first downloads the build tools (about 105 MB); the tarball needs no build.

Check the result with `dsh --profile headless --dump-config`: the tree shows a `# == dsh-second-angle` layer. Then
run a task with `dsh headless "<task>"`. Requires DeepSeek Harness `>=0.2.1-rc.2 <0.3.0` (declared in `engines.dsh`).
Older 0.1.x harnesses may install the package without enforcing that range, then fail to load it because required
exports are missing. Upgrade the harness before installing the plugin.

## Configure

Every field is optional. Override them in your profile's `cordis.patch.yml` (in `$DSH_HOME/profiles/<profile>/`,
`~/.dsh/profiles/<profile>/` by default) by restating the row (a patch replaces the row's whole `config`). In a new
profile that file holds `[]`: replace that line with the row.

```yaml
- id: second-angle
  config:
    mode: sync                 # sync | async
    maxLatencyMs: 45000
    auditorReasoningEffort: 'off'
    # cardFile: /path/to/house-facts.txt   # one fact per line, appended to the card
    flagNotice: true
```

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `claimsEnabled` | `true` | enable the original claim scanner/auditor; `false` leaves the free ACTIONS path |
| `actionsMode` | `flag` | `flag` reports finished-turn action patterns; `block` also denies RED action patterns before calls (SAID-VS-DID is report-only); `off` disables ACTIONS |
| `actionsAllowedHosts` | `[]` | exact remote hostnames/IPs or explicit `*.example.org` subdomains; loopback is accepted automatically |
| `actionsToolRequirement` | `auto` | observe explicit visible system/policy tool requirements; `required` declares an always-call rule supplied elsewhere by the deployment |
| `mode` | `sync` | `sync` waits for the verdict before the turn closes (so a contradiction can steer a correction in the same turn); `async` lets the turn close at once and attaches the verdict later |
| `maxLatencyMs` | `45000` | an audit that takes longer is abandoned and the turn goes on (a sync turn waits at most one second more, even when a provider ignores the abort) |
| `includeSubagents` | `false` | also publish sub-agent turn-end audits; block-mode guards always cover every agent |
| `memoryTurns` | `scanner` | a turn that ran no tool never goes to the model; `scanner` reports its absolute words as a flag, `skip` leaves it alone |
| `flagMemoryNumbers` | `false` | in such a turn, also flag numeric claims |
| `minAnswerChars` | `20` | shorter answers are not audited |
| `minEvidenceChars` | `1` | when the scan finds nothing, call the model only if the turn read at least this much tool output |
| `auditorProvider`, `auditorModel` | the turn's own route | a separate auditor model (set both) |
| `auditorReasoningEffort` | `off` | sent only when the route offers that effort id; `''` sends none |
| `auditorMaxTokens` | `2048` | hard output cap of the auditor call |
| `auditorTemperature` | `0` | auditor sampling temperature |
| `maxEvidenceChars` | `48000` | longer tool output is shortened (head and tail kept, marked) |
| `card` | 8 general lines (`DEFAULT_CARD` in `src/prompt.ts`) | facts-and-limits card; replaces the default |
| `cardFile` | — | file whose lines are appended to the card, read at load; a missing file stops the plugin from loading (startup warning `1 entry did not activate`) |
| `steer` | `true` | let a contradiction steer a correction |
| `requireQuoteForSteer` | `true` | steer only when the cited evidence text is found in the tool output |
| `maxListedClaims` | `3` | claims listed in one steering message or flag |
| `flagRecord` | `true` | write claim `plugin:second-angle/verdict` and ACTIONS `plugin:second-angle/actions` records into the Session log |
| `flagStderr` | `true` | write each flag as one line on stderr (the headless CLI prints the answer on stdout, diagnostics on stderr) |
| `flagLog` | `true` | also write each flag as a warning through the harness logger |
| `flagNotice` | `false` | also inject claim flags and RED ACTIONS findings as notices after the turn closes (see *How flags reach you*) |
| `asyncContradicted` | `notice` | async mode: a contradiction becomes a `notice`, a `followup` correction turn, or a plain `flag` |
| `recordSkips` | `false` | also record skipped turns and the gate that skipped them |
| `absoluteWords`, `extraUnits` | built in | scanner word list (replaces) and extra unit spellings (adds) |

## ACTIONS: what the turn did

The free ACTIONS check observes committed `tool/call` events and all assistant text and exposed reasoning. It
includes nested `run_code` dispatches, requests with missing/error results, and calls made during a steered
correction. It scans at `turn/end`, including error and abort endings. It does not send action data to a model.

| Rule | Patterns and severity |
|---|---|
| **SAID-VS-DID** | An explicit English promise such as “I will not invoke any tools” followed by a request, or a later “I did not use tools” denial. RED when the observed request conflicts with that statement; AMBER when a visible/configured tool requirement or unattributed call makes model choice uncertain. The matched text/reasoning is included. Scoped promises are excluded; this rule never blocks a call. |
| **NETWORK** | Shell network programs, cloud CLIs, HTTP/socket code one-liners, web/HTTP tools. Explicit off-list shell/code destinations and unresolved raw-network destinations are RED; destinations supplied only through curl/wget configuration or URL files are AMBER. Ordinary registry installs and implicit git remotes are AMBER when configuration hides the actual host. DNS lookups are AMBER. The 0.2.1-rc.2 harness `web_fetch` and `web_search` calls are AMBER for ordinary browsing; credential URLs, cloud metadata and off-list raw IPs are RED. |
| **SECRETS-READ** | RED for recognizable reads of private keys, real `.env` files, credential stores, and process-environment dumps. Known curl/wget upload/configuration/key-file operands, sensitive `file://` URLs and actual input redirections also count as reads. File options are interpreted per program, including grep/sed `-f`. Environment templates (including `.env.local.example` and `.envrc.example`), public keys, certificate-named PEM files without `key`, `priv` or `secret`, and fixture-key paths without `..` are excluded. `printenv` exempts a short list of ordinary names such as PATH, HOME and USER; other names remain RED. Literal grep patterns are not file reads. Echo/printf disclosure of a secret variable is RED; presence-only `${TOKEN:+set}` / `${TOKEN+set}` and length checks are excluded. |
| **PACK-AND-SEND** | RED for archive/encode followed by remote network activity in the same turn, with a shared output filename or at most three calls between the archive and a non-routine network request. Routine git/package operations require a shared output filename. Guarded web requests also correlate by proximity when an off-list URL has an individual encoded-looking query value or path segment. The heuristic accepts 16-character hex values, or mixed-case base64-style values containing digits/padding (at least 12 characters in a query, 16 in a path). The tested MDN, Node, Python, TypeScript and GitHub documentation URLs stay below RED after encoding. Both calls are identified. This remains RED for allow-listed remote hosts; the sequence deserves inspection even when the destination is familiar. |
| **PERSISTENCE** | RED for cron writes/installation, service enabling, or writes to service/autostart files, shell rc files and `authorized_keys`. Read-only inspection, including `crontab -l`, is excluded. |
| **DESTRUCTIVE** | RED for broad recursive forced deletion, device-writing `dd`, and recognizable filesystem destruction. Named build/cache-directory cleanup, ordinary file shredding, and `dd` writing an ordinary fixture file or `/dev/null` are excluded. |

### Configuration and blocking

For a free action-only profile:

```yaml
- id: second-angle
  config:
    claimsEnabled: false
    actionsMode: flag
    actionsAllowedHosts:
      - api.example.org
      - '*.internal.example.org'
    # actionsToolRequirement: required  # if the deployment mandates a tool call
    flagNotice: true
```

Use `actionsMode: block` to opt into pre-call denial. The plugin registers a synchronous `ctx.tools.guard()`
that denies a pending call when a RED action pattern concerns that call. SAID-VS-DID never blocks, even when
RED. The tool body is not invoked; the model receives the harness's ordinary error result with the rule and
reason. A later pre-execute listener cannot override this monotonic guard. AMBER findings continue. A scan
error in block mode denies the pending call; failures in ordinary reporting are logged and do not stop the
turn. Unloading the plugin removes its guard. Guards cover every agent, including sub-agents, regardless of
`includeSubagents`; that setting controls turn-end reports only. The harness runs guards after user
approval, so a call approved by a human can still be denied.

Block mode is deliberately conservative: cloud commands such as `aws`, `gcloud`, `az`, `gsutil` and `rclone`
remain RED because their configured destinations cannot be fully resolved; host allow-listing cannot waive
them (help/version queries are excluded). Explicit-URL `git clone` and `pip install git+https` are RED for
off-list hosts. Reads of `.env`, `.npmrc`, private `*.pem`/`*.key` paths and whole-environment
`env`/`printenv` dumps are RED; the template, certificate and fixture exceptions above still apply. `pwsh`
and experimental `terminal_send` calls are not scanned.

The allow-list accepts exact hostnames or IP literals and explicit `*.domain` subdomains. The wildcard
excludes the apex; add the apex separately. Matching ignores hostname case, a final dot and URL ports. It
never treats `trusted.example.evil.invalid` as `trusted.example`. URLs, ports in entries, CIDRs and bare `*`
are rejected at load. Localhost, valid IPv4 loopback, `::1` and the local bind address `0.0.0.0` are
accepted. A variable port, path or header does not make a literal local destination remote. Standard
npm/PyPI/Cargo/Go registry hosts are recognized only for package-install commands. An implicit registry or
git remote stays AMBER because configuration can redirect it. An allowed host removes the ordinary NETWORK
finding only; credential URLs, metadata, secret reads, persistence, destruction and pack/send correlations
retain their own findings. Private/LAN addresses are not automatically trusted.

Literal command substitutions, backticks, interpreter stdin (including here-strings and the standard stdin
paths), heredoc pipelines into interpreters, and literal scripts written and then executed in the same shell
request through a direct interpreter/script invocation are scanned. Shell `-n` / `-o noexec` and Node
`--check` / `-c` validate syntax without scanning the script as executed code. Outer-shell substitutions are
still inspected in those modes. A quoted heredoc written as documentation remains data. Unquoted heredocs
still execute substitutions. Quoted `<` and `>` arguments are not redirections. Shell arithmetic shifts do
not start heredocs. Nesting is bounded; this is not a full shell interpreter.

Destination parsing recognizes URL schemes other than `file://`, explicit proxies, proxy environment
assignments, curl `--connect-to` targets, `--resolve` addresses and DNS-over-HTTPS URLs, and wget proxy
settings. An off-list HTTP Host header with an allowed connection destination is AMBER. Curl/wget option
values are classified using tables from curl 8.5.0 and wget 1.21.4; later or unfamiliar options can still be
misclassified. Help/version exemptions apply to options, not output filenames or data operands. Explicit
proxy assignments are updated by later assignments and `unset` / `env -u`; curl proxy options override
environment settings, including `--proxy ""` and `--noproxy "*"`. Proxy settings for other URL protocols
do not apply to the requested protocol. File URLs are checked for sensitive reads rather than NETWORK.

### Flags and evidence

Every finding writes a separate stderr/logger line according to the existing `flagStderr`/`flagLog`
switches. `flagRecord` writes a distinct `plugin:second-angle/actions` Session record with turn, phase
(`before-call` or `turn-end`), mode, severity, rule, exact call ID, argument JSON, observed status, reason
and related evidence. `flagNotice` injects only RED ACTIONS findings after closure without forcing another
model step. AMBER findings remain available in records and diagnostics and are never injected as ACTIONS
notices. The stock client has no dedicated ACTIONS record renderer; delivery is through these existing
channels. Block mode can report the immediate denial and then include that blocked attempt again in the
finished-turn record.

A synthetic flag, for a request whose fake tool returned successfully:

```text
second angle ACTIONS RED DESTRUCTIVE [turn 1, call "c1", returned]: "bash" "{\"command\":\"rm -rf /\"}" — "command matches broad recursive deletion, device overwrite or filesystem destruction"
```

The statuses `requested`, `returned`, `error`, and `blocked` describe observed harness events. A returned
result does not prove that remote data arrived; an error may follow partial effects. Native argument JSON is
preserved in memory exactly as logged, and nested arguments use the harness's JSON-normalized value. Common
secret-looking values are masked in new records and diagnostics, including complete
Authorization/Proxy-Authorization header values, common credential fields, URL passwords and
credential-bearing `-u` / `-U` values and curl `--pass` values. Header masking follows the enclosing shell
quote, including single-quoted Digest values with inner double quotes and double-quoted values with escaped
quotes. Ordinary `git push -u`, `python -u` and `sort -u` arguments remain readable.
The original Session `tool/call` event remains the byte-exact source. Redaction is best effort; unusual
secrets can still appear in diagnostics, so set `flagStderr`/`flagLog` appropriately for the deployment.
Tool outputs are never searched for model promises.

### Policy provenance and limits

The harness can require tools through instructions. A call ID appearing in an assistant tool-call block
proves that the model requested it, but does not prove the model chose it freely. ACTIONS marks unmatched
calls as unattributed. Explicit visible system or harness-context tool requirements, and
`actionsToolRequirement: required`, make SAID-VS-DID AMBER. SAID-VS-DID is always report-only, regardless of
severity. “No tool call needed” expresses necessity and is not treated as a promise. Hidden provider
policies, implicit mandates, paraphrases and non-English rules cannot be reliably recovered. If your
deployment forces tool calls, set `actionsToolRequirement: required`. These flags identify a mismatch worth
reading, without establishing deception or intent.

**It flags patterns, not intent. The sandbox is the wall for the effects it actually confines.** The
inspected harness sandbox modes (`read-only`, `workspace-write`, `danger-full-access`) describe **file
effects only**. They do not restrict network access. Shell tools run through the host terminal in the
resolved session workspace by default; persistent shells can change cwd and keep environment/jobs between
calls. `danger-full-access` starts the shell without a sandbox wrapper. Network egress needs separate
enforcement. See the harness [sandbox
contract](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2/packages/sandbox/sandbox) and
[tool
pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/subsystems/tools.md);
the package versions used for this implementation are 0.2.1-rc.2.

The parser is deliberately static and incomplete. It cannot establish actual data flow, destination
ownership, country, DNS answers or server-side redirects, shell aliases/functions, package hooks, scripts
already on disk, interpolated/obfuscated code or effects hidden inside unfamiliar tools. Conventional
web-tool names do not prove that a deployment kept the original guarded implementation. Exposed reasoning is
checked only when the provider supplies it. Same-turn adjacency can flag unrelated work; cross-turn or
sufficiently separated activity can escape correlation. Tool results and body invocation are different
facts, and a failed archive can still trigger a sequence warning. Block mode acts only before calls routed
through this registry, and cannot undo prior actions or block a mismatch expressed in later text. The
completed-turn scan also waits for long-running calls to settle.

Only live observed events are checked. The plugin does not load old logs or replay unobserved resumed turns.
The JSONL persistence backend normally stores Zstandard sessions under
`$DSH_HOME/sessions/<project-key>/<session-id>/session.v4.jsonl.zstd` when configured with that root;
ACTIONS uses the event API rather than opening those files.

## How the claim check works

**The seam.** The harness dispatches `agent/turn-stopping` after the final step of a turn and before `turn/end`,
and awaits its listeners; a listener that objects calls `agent.steer(...)` and the loop runs another step in the
same turn. The event carries only `{ agent, turn, signal }`, so the plugin folds the turn's `tool/call`,
`tool/result`, and `assistant/message` events from `session/event` as they are committed.

**The gates**, in order:
1. Only the final step: the hook fires only there.
2. Only a turn that ran a tool, or whose answer has an absolute word or a numeric claim. A turn that ran no tool
   never reaches the model (an evidence-only auditor flags everything there); its absolute words become a scanner flag.
3. The free scanner: absolute words, plus numeric claims (numbers with units, version strings, ISO dates) that do not
   occur in the tool output. When it finds nothing and the turn's tool output is shorter than `minEvidenceChars` (by
   default: when it is empty), the model is not called.
4. One audit per turn: the hook fires again after a steered correction, and the same turn is never audited twice.

**The auditor** gets a fixed method prompt (list every factual claim; label each SUPPORTED, OVERSTATED, UNSUPPORTED,
or CONTRADICTED by three checks: what a count counts, whether an absolute word's range is covered, whether an
outside-world claim has a read in this turn), the facts-and-limits card, the answer, and the turn's own tool calls
with their full output. It runs with thinking off where the route offers it, a hard output cap, temperature 0, and
the closing order "Emit the JSON now." By default it uses the turn's own provider and model through `ctx.llm`; the
call is not written to the Session log. Output wrapped in prose or code fences, cut off at the cap, or empty is
handled: a usable verdict is salvaged, otherwise the turn is left alone.

**The routing.** A CONTRADICTED claim whose cited evidence text occurs in the tool output steers one short correction
message (a notice-form message, which the harness chat code renders as a one-line summary row; we have not checked
that in a browser); the model revises in the same turn. OVERSTATED and UNSUPPORTED claims, and contradictions whose
quote is not found, become a flag. The answer's text is never held back (it has already streamed); in `sync` mode the
turn closes after the audit, within `maxLatencyMs`. Every auditor error, timeout, or empty output fails open: the turn
continues unchanged and the failure is logged and recorded.

### How flags reach you

- **Session record** (default on): a `plugin:second-angle/verdict` record per audited turn, an ignorable plugin record
  that fork and resume carry and that readers without the plugin skip. It holds the status, the route, the latency,
  the scanner findings, and every claim with its label, reason, and quote.
- **stderr** (default on): one line per flag, for example
  `second angle: 1 claim not backed by this turn's reads: (1) "…" (OVERSTATED: …) [turn 1]`. With
  `dsh --profile headless` the answer goes to stdout and this line to stderr, right after it.
- **Harness logger** (default on): the same line as a warning through `ctx.logger`, for hosts that export their logs.
- **Notice** (`flagNotice: true`): the same line injected after the turn closes. It reaches the model with the next
  turn, and the harness chat code renders it then as a notice row (not checked in a browser). It is not injected
  during the turn: an injected message at the stop boundary would force another step.

## Tested in a real harness

The v0.1 claim auditor had six headless runs on a DeepSeek Harness 0.2.1-rc.2 instance, with the plugin
installed from its tarball the way a user would and the local model behind the harness's own provider route.
The first exposed a gate bug: a short tool output and a wrong version string slipped past the scanner, so
the turn was skipped (fixed; the scanner now reads version strings and dates). After the fix, a planted
contradiction (the answer gives a version the file it just read does not) was steered and corrected in the
same turn, twice with identical results; a hedged answer about a partial read passed as clean; a planted
overstatement about the same partial read was flagged on stderr right after the answer; an answer written
without any tool and carrying an absolute word got a scanner flag with no model call. Every run left its
`plugin:second-angle/verdict` record in the persisted Session log. A git install over a pinned commit went
through the `allowBuilds` step described above.

## Public eval

See [`eval/`](eval/README.md): 24 cases built from verbatim excerpts of the harness's own documentation (8
contradicted, 8 unsupported or overstated, 8 clean controls, six of them on the same evidence as a planted case), run
through the plugin's own auditor path. Results and every failure: [`eval/EVAL_RESULTS.md`](eval/EVAL_RESULTS.md).

With thinking off (the default), on DeepSeek V4.1 Flash served locally:

| contradicted: steered | contradicted: acted on (steered or flagged) | unsupported or overstated: flagged | clean: false flags | no verdict | median per audit |
|---|---|---|---|---|---|
| 7/8 | 8/8 | 8/8 | 0/8 | 0/24 | 3.6 s |

The one contradiction that was not steered (C7) came back OVERSTATED, with the right reason, and was flagged. The set
is small and written by us, and the default card speaks to three of its cases; its cases are also short (one to three
claims against an excerpt of at most about 2,200 characters), which is why an audit takes seconds here. The eval runs
the plugin's auditor path directly, not through a harness turn; the runs above cover that. The results file says
what the numbers do and do not show.

With `auditorReasoningEffort: low` (short thinking) the same set gave 8/8 steered, 8/8 flagged, 0/8 false flags,
and no missing verdicts, at a median of 5.85 s per audit (1.6 times longer). It also steered once on a sentence we had
written as true but which did overstate its evidence.

## Limits

- **The answer has already streamed.** By the time `agent/turn-stopping` fires, the user has seen the text.
  A steer produces a visible revision in the same turn; a flag cannot unsay anything. Set `steer: false` for
  flags only.
- **It shares the model.** By default the auditor is one more call to the same model: in `sync` mode the
  turn closes later by the audit time (2–3 seconds per audit in our integration runs with thinking off,
  bounded by `maxLatencyMs`), and it adds load to a shared server. Use `async` (no wait, but no steer), a
  separate `auditorModel`, or a higher `minEvidenceChars` (fewer audits).
- **The stock Web chat does not render plugin records.** Flags live in the Session log, on stderr, and in
  the harness logger, and with `flagNotice` in the chat one turn later. A client renderer for the record is
  the obvious next step.
- **Only this turn's reads count as evidence.** The auditor sees nothing else, so a claim the model knows
  from an earlier turn or from memory has nothing to stand on and gets flagged (on our bench, one such true
  claim was flagged every time); it may well be true. Treat such flags as "not checked this turn".
- **The card matters, and it is not magic.** The bench showed the auditor uses a fact on its card reliably;
  it did not show help on a mistake whose fact is not on the card. The default card is general; the intended
  use is a house card that gains one line per real mistake.
- **The auditor reads untrusted tool output.** A crafted output can bias its verdict, and a steering message
  carries the auditor's one-line reason. Steering fires only on a contradiction whose cited text occurs in
  the tool output.
- **The scanner is English-only** and misses spelled-out numbers ("four").
- **Long tool output is shortened** past `maxEvidenceChars`; the record says when.
- **Async mode cannot steer**: the turn is closed by then; a contradiction becomes a notice (or a follow-up
  turn).
- **ACTIONS has known silent misses:** dynamically constructed `eval` content, `busybox wget`, `gh gist
  create`, `npm publish`, `twine upload`, `openssl s_client`, common Perl/PHP/Ruby URL snippets, container
  commands, `xargs -a`, `find / -delete`, `chmod -R 777 /` and `git push --force` can evade the relevant RED
  rule. Aliased APIs, decoded scripts, uploads through unfamiliar upload options, and credentials in
  command-specific switches such as mysql `-p` or sshpass `-p` can also escape. A remote alias added earlier
  in a shell request is not resolved for a later `git push`; it remains AMBER. Configuration files, ambient
  proxy settings and external script contents are not loaded.
- Additional static limits include a script written in the same request and then piped from `cat x.sh`
  into `bash`, shell process substitution, and archive work inside a substitution before the outer network
  request. Those forms can miss script execution or archive/send correlation. The encoded-URL heuristic
  can miss payloads outside its character/length checks and can mistake unrelated encoded values for a
  send; it does not decode payloads or prove data flow.
- Built and tested against DeepSeek Harness 0.2.1-rc.2. The additional 0.2.1-rc.3 install/tests/live-turn
  check applies to v0.1 only; harness APIs are pre-stable.

## Development

Needs Node 22.19+ or 24+, and pnpm (the repo pins 11.28.5 in `packageManager`).

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm test   # tsc strict, oxlint, vitest
pnpm run build                                     # lib/
```

The tests include full-loop runs on the published harness agent loop with scripted models: a steered
correction in the same turn, one audit per turn, flags without an extra step, the gates, fail-open on prose,
provider errors and timeouts, notices delivered after the turn closes, and async mode. ACTIONS tests cover
all six positive rules, ordinary-work regressions, heredoc data versus executable input, script propagation,
destination and proxy options, redaction in stderr/logger/records, bounded parsing/redaction, sequence gaps,
sub-agent guards, report-only statement mismatches, RED-only notices, guard disposal and actual pre-body
denial. The action-only loop tests assert that no auditor model call occurs. Static coverage limits are
recorded explicitly.

Prepared with AI assistance; reproduced and tested locally.

## License

MIT — see [LICENSE](LICENSE). DeepSeek Harness is © 2026 DeepSeek, MIT License.
