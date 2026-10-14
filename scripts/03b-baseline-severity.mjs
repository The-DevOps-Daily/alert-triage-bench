// Baseline with no model: route by the severity label the alert author set
// (critical -> page, warning -> ticket, anything else -> ignore). This is what
// a plain Alertmanager route does, and it is the bar every model must clear.
//
//   node scripts/03b-baseline-severity.mjs   -> results/raw/baseline_severity-label.jsonl
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const alerts = readFileSync(new URL('data/alerts.jsonl', root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const decide = (s) => (s === 'critical' ? 'page' : s === 'warning' ? 'ticket' : 'ignore');
const rows = alerts.map((a) => ({
  model: 'baseline:severity-label', run: 1, id: a.id, label: a.label, decision: decide(a.alert.severity),
  served: 'none', status: 200, attempts: 1, ms: 0, usage: { in: 0, out: 0, reasoning: 0 }, cost: 0, priced: true,
}));
writeFileSync(new URL('results/raw/baseline_severity-label.jsonl', root), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const ok = rows.filter((r) => r.decision === r.label).length;
console.log(`severity-label baseline: ${ok} of ${rows.length} correct`);
