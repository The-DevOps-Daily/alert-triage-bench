# alert-triage-bench

```bash
cp .env.example .env   # add a DigitalOcean Serverless Inference model access key
set -a; . ./.env; set +a
rm -rf results/raw && mkdir results/raw   # the runner reuses any result already on disk
npm run alerts && npm run baseline && npm run run && npm run score
```

Page, ticket or ignore: does a cheap model on DigitalOcean Serverless Inference route monitoring alerts as well as the most expensive one?

200 alerts, one written on-call policy, six models and three runs each. No dependencies, Node 20 or later.

DigitalOcean's Inference Router is in public preview, and its preview terms do not allow publishing test results without DigitalOcean's written consent, so this repo covers the direct models only.

## The claim it could have disproved

A cheap model, given a clear written policy, makes the page/ticket/ignore call as well as the most expensive model available, and in particular misses no more pages.

## What each script does

| script | output | what it does |
|---|---|---|
| `scripts/01-generate-alerts.mjs` | `data/alerts.jsonl` | Builds 200 Alertmanager-style alerts from structured fields (seeded, mulberry32) and labels each one by applying `POLICY.md` to those fields. About half carry a `severity` label that points the wrong way, on purpose. |
| `scripts/02-check-labels.mjs` | `results/label-agreement.txt` | Compares the labels with a second reader (Codex, given only the policy and the alert text). |
| `scripts/03-run-models.mjs` | `results/raw/<model>.jsonl` | One call per alert, per model, per run. Records the decision, the model that served the call, tokens, cost and latency. Resumes after a crash (it skips any call already on disk, so start from an empty `results/raw` for new alerts) and stops near a budget (`--budget 5`; checked after each call, so calls in flight can go past it). Earlier runs kept the first 400 characters of each reply; it now keeps the full text and the total time including retries. |
| `scripts/03b-baseline-severity.mjs` | `results/raw/baseline_severity-label.jsonl` | No model: route by the severity label (critical pages, warning tickets, the rest is ignored). |
| `scripts/04-score.mjs` | `results/summary.md`, `results/summary.json` | Accuracy, missed pages, false pages, run-to-run agreement, cost per 1,000 alerts, latency percentiles, the model that served each call, a paired bootstrap against the reference model, and binomial upper bounds on what 200 alerts can rule out. |

`prices.json` holds the per-token prices used for cost, with the source page and the date checked.

## Result (2026-10-14)

| model | correct (of 600) | page alerts missed in any run (of 50) | $ per 1,000 alerts | p50 | p95 |
|---|---|---|---|---|---|
| deepseek-v4-flash-0731 | 600 | 0 | 0.157 | 4.4 s | 10.7 s |
| qwen3.8-max | 600 | 0 | 1.640 | 1.3 s | 2.6 s |
| openai-gpt-oss-120b | 599 | 0 | 0.194 | 3.1 s | 5.1 s |
| llama-4-maverick | 597 | 2 | 0.189 | 1.9 s | 3.3 s |
| openai-gpt-oss-20b | 595 | 3 | 0.144 | 2.4 s | 5.3 s |
| mistral-3-14B | 532 | 8 | 0.149 | 0.8 s | 1.8 s |
| severity label, no model | 102 of 200 | 14 | 0 | | |

Full tables, including the bootstrap and the upper bounds, are in `results/summary.md`. Costs are estimates: the scorer prices every call from its recorded token usage and `prices.json`. The whole run, 3,600 scored calls plus 36 reruns, came to about $1.50. Latency is the final attempt of each call (only `mistral-3-14B` needed retries, on 11 calls); the main run used `--concurrency 6`. The scorer takes the first decision in each reply and counts an empty reply as wrong.

Zero errors on 200 alerts does not mean zero errors: it still allows a true per-alert error rate of up to 1.5%, and zero misses on 50 page alerts allows a true miss rate of up to 5.8%.

The account used here could not call the GPT-5 or Claude models on DigitalOcean (403, "not available for your subscription tier"), so the comparison is between open-weight models (`results/model-access-2026-10-14.txt`).

## The bug the models found

The first version of the generator put two maintenance-window alerts after their window had ended ("active until 05:00 UTC" on an alert that started at 05:35). The labels said ignore; the text said page. The second reader agreed with the wrong labels. `qwen3.8-max` and `gpt-oss-120b` paged every time, `llama-4-maverick` and `mistral-3-14B` trusted the word "active" every time. The generator now keeps maintenance alerts inside their window. The original two alerts and every model's answers to them are kept in `results/v1-maintenance-bug/`.

## Write-up

https://devops-daily.com/posts/cheap-model-alert-triage-digitalocean-inference

## License

MIT
