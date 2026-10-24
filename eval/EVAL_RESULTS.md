# Eval results — 24 Oct 2026

**What ran.** Every case in [`cases.jsonl`](cases.jsonl) went once through the plugin's own auditor path —
`renderEvidence` → `buildAuditorPrompt` (the default 8-line card) → `runAuditorCall` (output cap 2048 tokens,
temperature 0) → `parseVerdict` → `routeVerdicts` (steer only on a contradiction whose quote is found in the
evidence) — against DeepSeek V4.1 Flash served locally behind an OpenAI-compatible endpoint. The transport in
`run-eval.ts` is a small HTTP client that sends the fields the harness pi-ai route sends for the auditor call
(`model`, a system and a user message, `max_tokens`, `temperature`, `chat_template_kwargs`); everything after it is the
plugin's code. The runner waited for the server to be idle before each call, so the times are service times. Raw
output, with every claim, label, reason, and quote: [`results/raw-2026-10-24.jsonl`](results/raw-2026-10-24.jsonl).
Scored with `node eval/score.ts eval/results/raw-2026-10-24.jsonl`.

## Thinking off (the plugin default) — all 24 cases

| contradicted: steered | contradicted: acted on | unsupported: flagged | overstated: flagged | clean: false flags | no verdict | median s / call |
|---|---|---|---|---|---|---|
| 7/8 | 8/8 | 4/4 | 4/4 | 0/8 | 0/24 | 3.6 (range 2.0–9.9) |

Per case: C1–C6 and C8 steered, each naming the planted claim and quoting the evidence that contradicts it. C7 (the
answer calls 36 listed files "36 separate guides"; the listing shows 12 guides, each as three files) came back
OVERSTATED with the right reason ("they are files (12 guides × 3 files each: .md, .zh.md, .i18n.yaml)"), so the
plugin flagged it instead of steering. U1–U8 were all flagged on the planted claim (U6, an overstatement, was labelled UNSUPPORTED). K1–K8 drew no
action; every claim in them came back SUPPORTED with a quote found in the evidence.

EFFORT_LOW_PLACEHOLDER

## What this does and does not show

- **The set is small and ours.** 24 cases, written by the plugin's authors, one run each at temperature 0; repeat
  runs were not made. With 8 cases per kind, 8/8 is consistent with a true rate well below 100 %.
- **The card helps on purpose.** The default card carries general lines about `grep`, `head`, and directory
  listings; U3, U4, and C7 exercise exactly those, and the auditor's reasons for U3 and U4 make the card's point (a
  grep covers only the files it searched; `head` shows only part). A mistake whose fact is on no card was not
  measured separately.
- **The errors are clean.** Each planted claim contradicts or outruns a short, verbatim excerpt; real answers mix many
  claims and longer outputs. Our two integration audits on a real harness instance (one steered correction, one clean
  answer) took 2.1 s and 2.6 s, within this range.
- **One model.** Results for other models, or for the harness's other providers, are not covered.
