# Public eval set

24 cases, each one **evidence** (what a tool printed in a turn) plus one **answer** (what the assistant then wrote):

| kind | cases | what the plugin should do |
|---|---|---|
| contradicted | C1–C8 | steer a correction (the evidence shows a different value) |
| unsupported | U1, U2, U5, U7 | flag the claim the evidence does not address |
| overstated | U3, U4, U6, U8 | flag the claim that says more than the evidence covers |
| clean | K1–K8 | nothing (every claim is shown by the evidence) |

The clean controls reuse the same evidence as the planted cases wherever possible, so a false flag cannot hide behind
an easier excerpt.

**Where the evidence comes from.** Every evidence text is a verbatim excerpt of the public DeepSeek Harness
repository at commit `687f282e` (release 0.2.1-rc.2): its documentation and a few source files. The `source` field of
each case names the file and lines. DeepSeek Harness is © 2026 DeepSeek, released under the MIT License; the
excerpts are quoted here for evaluation. The answers were written for this set.

**What a case measures.** A case counts as caught when the plugin's routing acts on the planted claim: a steer for a
contradiction, a flag for an unsupported or overstated claim. The planted claim is matched by the case's `target`
keywords against the claim text the auditor returned. A clean case counts as a false flag when the plugin would act
at all.

**Run it** against any OpenAI-compatible endpoint that serves your model:

```sh
node eval/run-eval.ts --base-url http://127.0.0.1:8000/v1 --model YOUR-MODEL --efforts off,low --out eval/results/raw.jsonl
node eval/score.ts eval/results/raw.jsonl
```

`--efforts` takes reasoning-effort ids; `off` sends `chat_template_kwargs: {"enable_thinking": false}` and any other id
sends `{"enable_thinking": true, "reasoning_effort": "<id>"}` — the fields the harness pi-ai route sends for a
`chat-template` model. Point `--wait-health` at a server health URL to wait while it is busy.
