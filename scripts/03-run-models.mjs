// Stage 3: ask each model for a decision on every alert, several runs each.
//
// One JSON line per call in results/raw/<model>.jsonl, with the decision, the
// model that actually served the call (routers pick one), token usage, cost
// and wall-clock latency. Re-running skips calls already on disk, so a crash
// or a budget stop resumes where it left off.
//
//   DO_INFERENCE_KEY=... node scripts/03-run-models.mjs [--runs 3] [--limit 20] [--models a,b] [--budget 5]
import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';

const KEY = process.env.DO_INFERENCE_KEY;
if (!KEY) throw new Error('DO_INFERENCE_KEY is not set');
const URL_ = 'https://inference.do-ai.run/v1/chat/completions';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const RUNS = Number(arg('runs', 3));
const LIMIT = Number(arg('limit', 0));
const BUDGET = Number(arg('budget', 5));
const CONCURRENCY = Number(arg('concurrency', 4));
const MODELS = arg('models', [
  'router:general',
  'router:software-engineering',
  'openai-gpt-oss-20b',
  'deepseek-v4-flash-0731',
  'mistral-3-14B',
  'openai-gpt-oss-120b',
  'llama-4-maverick',
  'qwen3.8-max',
].join(',')).split(',');

const root = new URL('..', import.meta.url);
const prices = JSON.parse(readFileSync(new URL('prices.json', root))).models;
const policy = readFileSync(new URL('POLICY.md', root), 'utf8');
let alerts = readFileSync(new URL('data/alerts.jsonl', root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
if (LIMIT) alerts = alerts.slice(0, LIMIT);

const SYSTEM = `You route monitoring alerts for an on-call team. Apply this policy exactly.

${policy}

Reply with JSON only, no other text: {"decision": "page" | "ticket" | "ignore", "reason": "<one short sentence>"}`;

// Unknown routed models are charged at a deliberately high rate so the budget
// check errs on the safe side; the report flags them.
const FALLBACK_PRICE = { in: 5, out: 25 };
function cost(model, usage) {
  const p = prices[model] ?? FALLBACK_PRICE;
  return ((usage?.prompt_tokens ?? 0) * p.in + (usage?.completion_tokens ?? 0) * p.out) / 1e6;
}

function parseDecision(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (['page', 'ticket', 'ignore'].includes(j.decision)) return j.decision;
  } catch {}
  const m = text.match(/"decision"\s*:\s*"(page|ticket|ignore)"/i) ?? text.match(/\b(page|ticket|ignore)\b/i);
  return m ? m[1].toLowerCase() : null;
}

const rawDir = new URL('results/raw/', root);
const fileFor = (model) => new URL(`${model.replace(/[^a-z0-9.-]+/gi, '_')}.jsonl`, rawDir);

function loadDone() {
  let spent = 0;
  const done = new Set();
  for (const f of readdirSync(rawDir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(new URL(f, rawDir), 'utf8').split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line);
      spent += r.cost ?? 0;
      if (r.decision !== undefined) done.add(`${r.model}|${r.id}|${r.run}`);
    }
  }
  return { spent, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(model, alert) {
  const started = performance.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    const t0 = performance.now();
    let res, body;
    try {
      res = await fetch(URL_, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: alert.text }],
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      body = await res.json().catch(() => ({}));
    } catch (err) {
      body = { error: String(err) };
    }
    const ms = Math.round(performance.now() - t0);
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (res?.ok || !retryable || attempt >= 5) return { res, body, ms, totalMs: Math.round(performance.now() - started), attempt };
    await sleep(Math.min(30_000, 1000 * 2 ** attempt + Math.random() * 500));
  }
}

let { spent, done } = loadDone();
console.log(`already on disk: ${done.size} calls, $${spent.toFixed(4)}`);

const jobs = [];
for (let run = 1; run <= RUNS; run++)
  for (const model of MODELS)
    for (const a of alerts) if (!done.has(`${model}|${a.id}|${run}`)) jobs.push({ model, a, run });
console.log(`to do: ${jobs.length} calls, budget $${BUDGET} (checked after each call, so calls in flight can go past it), concurrency ${CONCURRENCY}, runs ${RUNS}`);

let next = 0, stopped = false, finished = 0;
async function worker() {
  while (!stopped && next < jobs.length) {
    const { model, a, run } = jobs[next++];
    const { res, body, ms, totalMs, attempt } = await call(model, a);
    const text = body?.choices?.[0]?.message?.content ?? '';
    const served = body?.model ?? model;
    const c = res?.ok ? cost(served, body.usage) : 0;
    spent += c;
    const row = {
      model, run, id: a.id, label: a.label,
      decision: res?.ok ? parseDecision(text) : null,
      served, status: res?.status ?? 0, attempts: attempt, ms, totalMs,
      usage: body?.usage ? { in: body.usage.prompt_tokens, out: body.usage.completion_tokens, reasoning: body.usage.completion_tokens_details?.reasoning_tokens ?? 0 } : null,
      cost: c, priced: Boolean(prices[served]),
      finish: body?.choices?.[0]?.finish_reason ?? null,
      raw: text, error: res?.ok ? undefined : JSON.stringify(body?.error ?? body).slice(0, 300),
    };
    appendFileSync(fileFor(model), JSON.stringify(row) + '\n');
    finished++;
    if (finished % 50 === 0) console.log(`${finished}/${jobs.length} done, $${spent.toFixed(4)} spent`);
    if (spent >= BUDGET) {
      stopped = true;
      console.log(`budget reached at $${spent.toFixed(4)}, stopping`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`finished ${finished} calls, total spent $${spent.toFixed(4)}`);
