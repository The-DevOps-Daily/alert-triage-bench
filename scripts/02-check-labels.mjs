// Stage 2: compare the policy labels with an independent second reader.
//
// The second reader (Codex, given only POLICY.md and the rendered alert text,
// never the labels) wrote data/codex-labels.log. Any disagreement means the
// text does not carry what the label assumes, and that alert gets fixed.
//
//   node scripts/02-check-labels.mjs   -> results/label-agreement.txt
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const alerts = readFileSync(new URL('data/alerts.jsonl', root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const log = readFileSync(new URL('data/codex-labels.log', root), 'utf8');
const block = log.slice(log.lastIndexOf('BEGIN LABELS'), log.lastIndexOf('END LABELS'));
const second = Object.fromEntries([...block.matchAll(/^(a\d{3}) (page|ticket|ignore)\s*$/gm)].map((m) => [m[1], m[2]]));

const disagree = alerts.filter((a) => second[a.id] !== a.label);
const lines = [
  `alerts: ${alerts.length}`,
  `second reader labelled: ${Object.keys(second).length}`,
  `agreement: ${alerts.length - disagree.length} of ${alerts.length}`,
  ...disagree.map((a) => `  ${a.id} ${a.scenario}: policy=${a.label} second=${second[a.id] ?? 'missing'}`),
];
writeFileSync(new URL('results/label-agreement.txt', root), lines.join('\n') + '\n');
console.log(lines.join('\n'));
