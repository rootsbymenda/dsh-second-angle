# Changelog

## 0.2.1 — 2026-10-28

- Block mode now denies a tool call whose shell command is nested beyond the parser's inspection
  limit. Before, such a call returned no commands and was accepted without a full inspection.
- Pin Zod to 4.6.7 across the harness dependencies. The 4.4.3 resolution carried a published
  memory-exhaustion advisory for oversized constrained collections.

## 0.2.0 — 2026-10-27

- Add a free ACTIONS scan of live turn events: SAID-VS-DID, NETWORK, SECRETS-READ, PACK-AND-SEND,
  PERSISTENCE and DESTRUCTIVE. Preserve call identity, arguments, status and exposed text/reasoning.
- Default to `actionsMode: flag`; opt into pre-call RED denial with `block`, using the harness's monotonic
  tool guard for every agent. SAID-VS-DID remains report-only. `off` restores the claim-only path.
  `claimsEnabled: false` permits action-only use without model calls.
- Add exact/wildcard host allow-list configuration and `actionsToolRequirement` for deployments with an
  always-call policy. Known required or unattributed calls produce AMBER statement/action mismatches. No
  intent is inferred.
- Separate ACTIONS records from v0.1 claim verdicts, with existing stderr/logger/notice switches and
  best-effort secret masking. ACTIONS notices contain RED findings only. Cover turn-end errors, missing
  results, nested calls and steered continuations.
- Tune the scanner for quoted examples, local copies, loopback, ordinary registry/git work, guarded web
  browsing, DNS, actual persistence writes, and archive/network ordering and adjacency.
- Recognize heredoc substitutions, interpreter pipelines and literal scripts written and run in the same
  request. Check non-file URL schemes, explicit proxy/connection redirects, input reads and private-key
  names.
- Preserve ordinary curl/wget option operands and documentation heredocs; bound long-token redaction and
  mask complete authorization headers without hiding ordinary `-u` arguments.
- Distinguish syntax checks, quoted redirection text, secret-presence checks and documentation URLs from
  executed payloads. Track read options per program, sensitive file URLs, actual help/version options,
  and effective proxy overrides/unsets. Mask Digest headers according to their enclosing quotes, plus
  curl proxy-user and key-password options.
- Retain the original claim-auditor behavior and all 58 original tests. Add synthetic scanner, recorder and
  published-loop tests, including proof that a blocked tool body never runs and no action audit calls a
  model.
- Document static-pattern, policy-provenance and sandbox limitations. The 0.2.1-rc.2 harness's file sandbox
  has no network restriction, and `danger-full-access` bypasses its process wrapper.
- Add `@deepseek-ai/dsh-tools` as a peer; the plugin requires its registry service in every mode, including
  `flag` and `off`. No new runtime dependency.

## 0.1.0 — 2026-10-24

First version, built and tested against DeepSeek Harness 0.2.1-rc.2, and also checked on 0.2.1-rc.3.

- Audits a finished turn at `agent/turn-stopping`: rebuilds the turn's tool calls, tool output, and final text from the
  Session events, gates the turn, and asks a model auditor (thinking off, a facts-and-limits card, a hard output cap).
- Routes by severity: a contradiction that cites text found in the evidence steers a short correction, so the model
  revises in the same turn; an overstated or unsupported claim becomes a flag.
- Free scanner in front: absolute words, and numeric claims (numbers with units, version strings, ISO dates) that the
  tool output does not contain. Turns that ran no tool never reach the model; their absolute words become a scanner flag.
- One audit per turn (the hook fires again after a steered correction).
- Flags go to a `plugin:second-angle/verdict` Session record, one stderr line, and the harness logger, and optionally
  to a notice that reaches the model and the chat with the next turn.
- `sync` and `async` modes, a latency bound that holds even when a provider ignores the abort, and fail-open
  behavior on every auditor error, timeout, or empty output.
- A public eval set of 24 cases built from the harness's own documentation, with a runner and a scorer.
