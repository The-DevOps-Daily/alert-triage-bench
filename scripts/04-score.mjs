// Stage 4: score every model and compare each one with the most expensive model.
//
// Accuracy alone hides the error that matters. A missed page is an outage
// nobody hears about; a false page wakes someone for nothing. Both are counted
// separately. Differences between models use a paired bootstrap over alerts.
// Most models are near 100% here, where a bootstrap has nothing to resample,
// so each model also gets a one-sided 95% upper bound on its per-alert error
// rate: zero errors on 200 alerts still allows a true rate of about 1.5%.
//
//   node scripts/04-score.mjs [--ref qwen3.8-max]   -> results/summary.json, results/summary.md
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mulberry32 } from '../src/rng.mjs';

const root = new URL('..', import.meta.url);
const refArg = process.argv.indexOf('--ref');
const REF = refArg > -1 ? process.argv[refArg + 1] : 'qwen3.8-max';
const B = 10_000;

const alerts = readFileSync(new URL('data/alerts.jsonl', root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byId = Object.fromEntries(alerts.map((a) => [a.id, a]));
const rawDir = new URL('results/raw/', root);
const rows = readdirSync(rawDir).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => readFileSync(new URL(f, rawDir), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));

// Price every call from its recorded token usage and the current prices.json,
// not from the cost the runner stored: early calls to a model missing from
// prices.json were stored at the runner's deliberately high fallback rate.
const prices = JSON.parse(readFileSync(new URL('prices.json', root))).models;
for (const r of rows) {
  const p = prices[r.served];
  if (p && r.usage) {
    r.cost = (r.usage.in * p.in + r.usage.out * p.out) / 1e6;
    r.priced = true;
  }
}

const models = [...new Set(rows.map((r) => r.model))];
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};

// Per model, per alert: share of runs that were correct, missed a page, or paged falsely.
function perAlert(model) {
  const m = {};
  for (const r of rows.filter((x) => x.model === model)) {
    const a = (m[r.id] ??= { n: 0, correct: 0, missed: 0, falsePage: 0, decisions: [] });
    a.n++;
    a.decisions.push(r.decision);
    if (r.decision === r.label) a.correct++;
    if (r.label === 'page' && r.decision !== 'page') a.missed++;
    if (r.label !== 'page' && r.decision === 'page') a.falsePage++;
  }
  return m;
}

function bootstrapDiff(ids, f) {
  // f(id) -> difference for one alert; returns mean, 95% CI and the SE.
  const rand = mulberry32(7);
  const vals = ids.map(f);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rand() * vals.length)];
    means.push(s / vals.length);
  }
  const sd = Math.sqrt(means.reduce((s, v) => s + (v - mean) ** 2, 0) / (B - 1));
  return { mean, lo: quantile(means, 0.025), hi: quantile(means, 0.975), se: sd };
}

// Smallest p with P(X <= k | n, p) <= 0.05: the one-sided 95% upper bound.
function upperBound(k, n) {
  const cdf = (p) => {
    let term = (1 - p) ** n, sum = term;
    for (let i = 1; i <= k; i++) {
      term *= ((n - i + 1) / i) * (p / (1 - p));
      sum += term;
    }
    return sum;
  };
  let lo = k / n, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > 0.05) lo = mid; else hi = mid;
  }
  return hi;
}

const pa = Object.fromEntries(models.map((m) => [m, perAlert(m)]));
const pageIds = alerts.filter((a) => a.label === 'page').map((a) => a.id);
const allIds = alerts.map((a) => a.id);

const summary = models.map((model) => {
  const mine = rows.filter((r) => r.model === model);
  const ok = mine.filter((r) => r.status === 200);
  const runs = [...new Set(mine.map((r) => r.run))].sort();
  const perRun = runs.map((run) => {
    const rr = mine.filter((r) => r.run === run);
    return {
      run, n: rr.length,
      accuracy: rr.filter((r) => r.decision === r.label).length / rr.length,
      missedPages: rr.filter((r) => r.label === 'page' && r.decision !== 'page').length,
      falsePages: rr.filter((r) => r.label !== 'page' && r.decision === 'page').length,
    };
  });
  const hard = mine.filter((r) => byId[r.id].hard), easy = mine.filter((r) => !byId[r.id].hard);
  const acc = (rr) => rr.filter((r) => r.decision === r.label).length / (rr.length || 1);
  const stable = Object.values(pa[model]).filter((a) => a.n > 1 && new Set(a.decisions).size === 1).length;
  const served = {};
  for (const r of ok) served[r.served] = (served[r.served] ?? 0) + 1;
  const cost = mine.reduce((s, r) => s + (r.cost ?? 0), 0);
  const ms = ok.map((r) => r.ms);
  // Alerts are the independent unit; three runs of one alert are not three samples.
  const wrongAlerts = Object.values(pa[model]).filter((a) => a.correct < a.n).length;
  const missedAlerts = pageIds.filter((id) => pa[model][id]?.missed > 0).length;
  const out = {
    model, calls: mine.length, failed: mine.length - ok.length, invalid: ok.filter((r) => r.decision === null).length,
    accuracy: acc(mine), accuracyHard: acc(hard), accuracyEasy: acc(easy),
    missedPagesPerRun: perRun.reduce((s, r) => s + r.missedPages, 0) / perRun.length,
    falsePagesPerRun: perRun.reduce((s, r) => s + r.falsePages, 0) / perRun.length,
    perRun,
    wrongAlerts, errorRateUpper95: upperBound(wrongAlerts, alerts.length),
    missedPageAlerts: missedAlerts, missRateUpper95: upperBound(missedAlerts, pageIds.length),
    allRunsAgree: stable / Object.keys(pa[model]).length,
    costPer1000: (cost / mine.length) * 1000,
    totalCost: cost,
    unpricedCalls: ok.filter((r) => !r.priced).length,
    retriedCalls: mine.filter((r) => (r.attempts ?? 1) > 1).length,
    // The prompt asks for one JSON object and nothing else. The first decision
    // found is the one scored, as an automated router would act on it.
    notPureJson: ok.filter((r) => { try { JSON.parse((r.raw ?? '').trim()); return false; } catch { return true; } }).length,
    conflictingReplies: ok.filter((r) => new Set([...(r.raw ?? '').matchAll(/"decision"\s*:\s*"(page|ticket|ignore)"/g)].map((m) => m[1])).size > 1).length,
    emptyReplies: ok.filter((r) => !(r.raw ?? '').trim()).length,
    latencyMs: { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: Math.max(...ms) },
    outputTokens: { p50: quantile(ok.map((r) => r.usage?.out ?? 0), 0.5), reasoningShare: ok.reduce((s, r) => s + (r.usage?.reasoning ?? 0), 0) / (ok.reduce((s, r) => s + (r.usage?.out ?? 0), 0) || 1) },
    served,
  };
  if (model !== REF && pa[REF]) {
    const share = (m, id, k) => (pa[m][id] ? pa[m][id][k] / pa[m][id].n : 0);
    out.vsRef = {
      ref: REF,
      accuracy: bootstrapDiff(allIds, (id) => share(model, id, 'correct') - share(REF, id, 'correct')),
      missedPageRate: bootstrapDiff(pageIds, (id) => share(model, id, 'missed') - share(REF, id, 'missed')),
    };
  }
  return out;
});

summary.sort((a, b) => b.accuracy - a.accuracy || a.costPer1000 - b.costPer1000);
writeFileSync(new URL('results/summary.json', root), JSON.stringify({ ref: REF, alerts: alerts.length, pageAlerts: pageIds.length, hardAlerts: alerts.filter((a) => a.hard).length, models: summary }, null, 2) + '\n');

const f1 = (x) => (x * 100).toFixed(1) + '%';
const pp = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1);
const md = [
  `# Results`,
  ``,
  `${alerts.length} alerts (${pageIds.length} page, ${alerts.filter((a) => a.label === 'ticket').length} ticket, ${alerts.filter((a) => a.label === 'ignore').length} ignore; ${alerts.filter((a) => a.hard).length} hard), up to 3 runs per model. Reference for the paired comparisons: ${REF}.`,
  ``,
  `| model | accuracy | hard | easy | missed pages /run (of ${pageIds.length}) | false pages /run | same answer all runs | $ per 1,000 alerts | p50 ms | p95 ms | calls (failed, invalid) |`,
  `|---|---|---|---|---|---|---|---|---|---|---|`,
  ...summary.map((s) => `| ${s.model} | ${f1(s.accuracy)} | ${f1(s.accuracyHard)} | ${f1(s.accuracyEasy)} | ${s.missedPagesPerRun.toFixed(1)} | ${s.falsePagesPerRun.toFixed(1)} | ${f1(s.allRunsAgree)} | ${s.costPer1000.toFixed(3)} | ${Math.round(s.latencyMs.p50)} | ${Math.round(s.latencyMs.p95)} | ${s.calls} (${s.failed}, ${s.invalid}) |`),
  ``,
  `## What 200 alerts can and cannot rule out (alerts are the unit; one-sided 95% upper bounds)`,
  ``,
  `| model | alerts wrong in any run (of ${alerts.length}) | true error rate could still be up to | page alerts missed in any run (of ${pageIds.length}) | true miss rate could still be up to |`,
  `|---|---|---|---|---|`,
  ...summary.map((s) => `| ${s.model} | ${s.wrongAlerts} | ${f1(s.errorRateUpper95)} | ${s.missedPageAlerts} | ${f1(s.missRateUpper95)} |`),
  ``,
  `## Paired comparison with ${REF} (percentage points, 95% bootstrap CI over alerts)`,
  ``,
  `| model | accuracy diff | CI | missed-page rate diff | CI |`,
  `|---|---|---|---|---|`,
  ...summary.filter((s) => s.vsRef).map((s) => {
    const a = s.vsRef.accuracy, m = s.vsRef.missedPageRate;
    return `| ${s.model} | ${pp(a.mean)} | ${pp(a.lo)} to ${pp(a.hi)} | ${pp(m.mean)} | ${pp(m.lo)} to ${pp(m.hi)} |`;
  }),
  ``,
  `## Which model served each call`,
  ``,
  ...summary.map((s) => `- ${s.model}: ${Object.entries(s.served).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`),
  ``,
];
writeFileSync(new URL('results/summary.md', root), md.join('\n'));
console.log(md.join('\n'));
