# Changelog

## 0.1.0 — unreleased

First version, built and tested against DeepSeek Harness 0.2.1-rc.2.

- Audits a finished turn at `agent/turn-stopping`: rebuilds the turn's tool calls, tool output, and final text from the
  Session events, gates the turn, and asks a model auditor (thinking off, a facts-and-limits card, a hard output cap).
- Routes by severity: a contradiction that cites text found in the evidence steers a short correction, so the model
  revises in the same turn; an overstated or unsupported claim becomes a flag.
- Free scanner in front: absolute words, and numeric claims (numbers with units, version strings, ISO dates) that the
  tool output does not contain. Turns that ran no tool never reach the model; their absolute words become a scanner flag.
- One audit per turn (the hook fires again after a steered correction).
- Flags go to a `plugin:second-angle/verdict` Session record and the process log, and optionally to a notice that
  reaches the model and the chat with the next turn.
- `sync` and `async` modes, a latency bound, and fail-open behavior on every auditor error, timeout, or empty output.
- A public eval set of 24 cases built from the harness's own documentation, with a runner and a scorer.
