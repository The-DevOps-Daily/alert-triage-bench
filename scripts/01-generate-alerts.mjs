// Stage 1: generate 200 alerts with a known correct decision.
//
// Each scenario builds the alert from structured fields and applies POLICY.md
// to those fields, so the label comes from the policy, not from a model. The
// rendered text is what the models see. Stage 2 checks that the text carries
// enough information for a second reader to reach the same label.
//
//   node scripts/01-generate-alerts.mjs   -> data/alerts.jsonl
import { writeFileSync } from 'node:fs';
import { mulberry32, helpers } from '../src/rng.mjs';

const rand = mulberry32(20261014);
const { pick, between, int, chance, shuffle } = helpers(rand);

const TIER1 = ['checkout', 'payments', 'api-gateway', 'auth', 'search', 'storefront'];
const TIER2 = ['ci-runners', 'admin-dashboard', 'reporting', 'email-digest', 'image-resizer', 'feature-flags'];
const TEAMS = { checkout: 'payments', payments: 'payments', 'api-gateway': 'platform', auth: 'identity', search: 'discovery', storefront: 'web', 'ci-runners': 'platform', 'admin-dashboard': 'backoffice', reporting: 'data', 'email-digest': 'growth', 'image-resizer': 'web', 'feature-flags': 'platform' };
const STATEFUL = [
  { name: 'postgres-main', kind: 'database' },
  { name: 'postgres-orders', kind: 'database' },
  { name: 'redis-sessions', kind: 'cache' },
  { name: 'kafka-broker-2', kind: 'queue' },
  { name: 'rabbitmq-orders', kind: 'queue' },
];
const NONPROD = ['staging', 'dev', 'sandbox', 'preview'];

let clock = Date.parse('2026-10-05T00:00:00Z');
function startsAt() {
  clock += int(20, 300) * 60_000;
  return new Date(clock).toISOString().replace('.000', '');
}

// The severity label a rule author would most often pick. Used only to mark
// alerts where the label points the wrong way.
const SEVERITY_FOR = { page: 'critical', ticket: 'warning', ignore: 'info' };

function severity(label, mismatch) {
  if (!mismatch) return SEVERITY_FOR[label];
  return pick(Object.values(SEVERITY_FOR).filter((s) => s !== SEVERITY_FOR[label]));
}

function render(a) {
  const labels = Object.entries({ alertname: a.alertname, env: a.env, service: a.service, severity: a.severity, team: a.team, ...a.extraLabels })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const lines = [
    `status: ${a.status}`,
    `labels: ${labels}`,
    `summary: ${a.summary}`,
    `description: ${a.description}`,
    `startsAt: ${a.startsAt}`,
  ];
  if (a.endsAt) lines.push(`endsAt: ${a.endsAt}`);
  lines.push(`maintenance window: ${a.maintenance ?? 'none'}`);
  return lines.join('\n');
}

const pct = (v) => `${v}%`;

// Each scenario returns the alert fields, the decision, and the policy line
// that decides it. `hard` marks cases where a shortcut (the severity label,
// the word "production", the alert name) gives the wrong answer.
const scenarios = {
  // ---------- page ----------
  p_error_rate(mis) {
    const service = pick(TIER1), ratio = between(2.4, 9, 1), mins = int(5, 25), rps = int(400, 3000);
    return { label: 'page', rule: 'tier 1 errors above 2% for 5+ minutes in production', alert: { alertname: 'HighErrorRate', env: 'production', service, severity: severity('page', mis), status: 'firing',
      summary: `${service} 5xx ratio is ${pct(ratio)}`,
      description: `5xx responses on ${service} have been above 2% for ${mins} minutes. Current value ${pct(ratio)} of ${rps.toLocaleString('en-US')} req/s.` } };
  },
  p_latency(mis) {
    const service = pick(TIER1), p99 = between(2.2, 6.5, 1), mins = int(10, 40);
    return { label: 'page', rule: 'tier 1 p99 above 2 s for 10+ minutes in production', alert: { alertname: 'HighLatencyP99', env: 'production', service, severity: severity('page', mis), status: 'firing',
      summary: `${service} p99 latency is ${p99}s`,
      description: `p99 request latency on ${service} has been above 2s for ${mins} minutes. Current p99 ${p99}s, p50 ${between(0.2, 0.9, 2)}s.` } };
  },
  p_down(mis) {
    const service = pick(TIER1), mins = int(2, 15);
    return { label: 'page', rule: 'tier 1 service down in production', alert: { alertname: 'EndpointDown', env: 'production', service, severity: severity('page', mis), status: 'firing',
      summary: `${service} health check failing from all probe locations`,
      description: `Blackbox probe to https://${service}.internal/healthz has failed from 3 of 3 locations for ${mins} minutes. Last error: ${pick(['connection refused', 'HTTP 503', 'timeout after 10s'])}.` } };
  },
  p_burn_fast(mis) {
    const service = pick(TIER1), burn = between(14.4, 38, 1);
    return { label: 'page', rule: 'tier 1 SLO burn at 14x or faster', alert: { alertname: 'SLOErrorBudgetBurn', env: 'production', service, severity: severity('page', mis), status: 'firing',
      summary: `${service} availability SLO burning at ${burn}x`,
      description: `The 99.9% availability SLO for ${service} is burning error budget at ${burn}x over the last 1h (5m window also above threshold). At this rate the monthly budget is gone in ${Math.max(1, Math.round(720 / burn))} hours.` } };
  },
  p_disk(mis) {
    const s = pick(STATEFUL), mins = int(15, 55), used = between(93, 98.5, 1);
    return { label: 'page', rule: 'production stateful system runs out within 1 hour', alert: { alertname: 'DiskWillFillSoon', env: 'production', service: s.name, severity: severity('page', mis), status: 'firing', team: 'platform',
      summary: `${s.name} data volume ${pct(used)} full`,
      description: `The data volume on ${s.name} (${s.kind}) is ${pct(used)} full and growing. Linear prediction over the last 30 minutes: full in ${mins} minutes.` } };
  },
  p_conns(mis) {
    const db = pick(['postgres-main', 'postgres-orders']), max = pick([200, 400, 500]), used = Math.round(max * between(0.88, 0.96, 2)), mins = int(20, 55);
    return { label: 'page', rule: 'production database runs out of connections within 1 hour', alert: { alertname: 'PostgresConnectionsNearLimit', env: 'production', service: db, severity: severity('page', mis), status: 'firing', team: 'platform',
      summary: `${db} at ${used} of ${max} connections`,
      description: `${db} is using ${used} of max_connections=${max}. Connections have grown steadily for 2 hours; at the current rate the limit is reached in about ${mins} minutes.` } };
  },
  p_cert(mis) {
    const host = pick(['shop.example.com', 'api.example.com', 'auth.example.com', 'pay.example.com']), hours = int(3, 20);
    return { label: 'page', rule: 'public production certificate expires in under 24 hours', alert: { alertname: 'TLSCertificateExpiringSoon', env: 'production', service: 'edge', severity: severity('page', mis), status: 'firing', team: 'platform',
      summary: `Certificate for ${host} expires in ${hours} hours`,
      description: `The public certificate served on ${host}:443 expires in ${hours} hours. Automatic renewal has failed 3 times (last error: ACME DNS-01 challenge timed out).` } };
  },
  p_primary(mis) {
    const db = pick(['postgres-main', 'postgres-orders']);
    return { label: 'page', rule: 'production primary database unreachable', alert: { alertname: 'PostgresPrimaryUnreachable', env: 'production', service: db, severity: severity('page', mis), status: 'firing', team: 'platform',
      summary: `${db} primary not responding`,
      description: `The primary of ${db} has not answered health checks for ${int(2, 9)} minutes. Replicas report replication lag growing. No failover has happened.` } };
  },
  p_security(mis) {
    const what = pick([
      'root account API call from an IP address never seen before (AS-unknown), confirmed by the detector with high confidence',
      'an access key belonging to a deleted employee was used to list S3 buckets; the detector marks this as confirmed unauthorized access',
      'an interactive shell was opened inside a payments pod by an unknown process; runtime detector verdict: confirmed intrusion',
    ]);
    return { label: 'page', rule: 'confirmed unauthorized access in production', alert: { alertname: 'UnauthorizedAccessDetected', env: 'production', service: 'cloud-account', severity: severity('page', mis), status: 'firing', team: 'security',
      summary: 'Security detector: confirmed unauthorized access', description: `Detector finding: ${what}.` } };
  },
  p_redis_mem(mis) {
    const mins = int(20, 50);
    return { label: 'page', rule: 'production cache runs out of memory within 1 hour', alert: { alertname: 'RedisMemoryNearLimit', env: 'production', service: 'redis-sessions', severity: severity('page', mis), status: 'firing', team: 'identity',
      summary: `redis-sessions memory at ${pct(between(91, 97, 1))} of maxmemory`,
      description: `redis-sessions stores login sessions for auth and has maxmemory-policy noeviction. Memory has grown 2% every 10 minutes; at this rate writes start failing in about ${mins} minutes.` } };
  },

  // ---------- ticket ----------
  t_error_tier2(mis) {
    const service = pick(TIER2), ratio = between(3, 25, 1), mins = int(6, 45);
    return { label: 'ticket', rule: 'tier 2 service errors in production', alert: { alertname: 'HighErrorRate', env: 'production', service, severity: severity('ticket', mis), status: 'firing',
      summary: `${service} 5xx ratio is ${pct(ratio)}`,
      description: `5xx responses on ${service} have been above 2% for ${mins} minutes. Current value ${pct(ratio)} of ${int(5, 120)} req/s.` } };
  },
  t_error_below(mis) {
    const service = pick(TIER1), ratio = between(1.1, 1.9, 1), mins = int(10, 40);
    return { label: 'ticket', rule: 'tier 1 errors below the 2% page threshold', alert: { alertname: 'ElevatedErrorRate', env: 'production', service, severity: severity('ticket', mis), status: 'firing',
      summary: `${service} 5xx ratio is ${pct(ratio)}`,
      description: `5xx responses on ${service} have been above the team alert threshold of 1% for ${mins} minutes. Current value ${pct(ratio)}.` } };
  },
  t_latency_below(mis) {
    const service = pick(TIER1), p99 = between(1.1, 1.9, 1), mins = int(15, 60);
    return { label: 'ticket', rule: 'tier 1 p99 below the 2 s page threshold', alert: { alertname: 'HighLatencyP99', env: 'production', service, severity: severity('ticket', mis), status: 'firing',
      summary: `${service} p99 latency is ${p99}s`,
      description: `p99 request latency on ${service} has been above 1s for ${mins} minutes. Current p99 ${p99}s. Error ratio unchanged at ${pct(between(0.05, 0.3, 2))}.` } };
  },
  t_burn_slow(mis) {
    const service = pick(TIER1), burn = between(2, 9.5, 1);
    return { label: 'ticket', rule: 'tier 1 SLO burn below 14x', alert: { alertname: 'SLOErrorBudgetBurn', env: 'production', service, severity: severity('ticket', mis), status: 'firing',
      summary: `${service} availability SLO burning at ${burn}x`,
      description: `The 99.9% availability SLO for ${service} is burning error budget at ${burn}x over the last 6h. At this rate the monthly budget is gone in ${Math.round(720 / burn)} hours.` } };
  },
  t_disk_days(mis) {
    const s = pick(STATEFUL), hours = pick([int(6, 23), int(26, 110)]);
    const when = hours < 24 ? `${hours} hours` : `${Math.round(hours / 24 * 10) / 10} days`;
    return { label: 'ticket', rule: 'capacity runs out in more than 1 hour but less than 7 days', alert: { alertname: 'DiskWillFillSoon', env: 'production', service: s.name, severity: severity('ticket', mis), status: 'firing', team: 'platform',
      summary: `${s.name} data volume ${pct(between(80, 90, 1))} full`,
      description: `The data volume on ${s.name} (${s.kind}) is filling. Linear prediction over the last 6 hours: full in ${when}.` } };
  },
  t_cert_days(mis) {
    const host = pick(['shop.example.com', 'api.example.com', 'status.example.com', 'docs.example.com']), days = int(2, 13);
    return { label: 'ticket', rule: 'certificate expires in 1 to 14 days', alert: { alertname: 'TLSCertificateExpiringSoon', env: 'production', service: 'edge', severity: severity('ticket', mis), status: 'firing', team: 'platform',
      summary: `Certificate for ${host} expires in ${days} days`,
      description: `The public certificate served on ${host}:443 expires in ${days} days. The last renewal attempt failed: rate limited by the ACME server.` } };
  },
  t_crashloop_one(mis) {
    const service = pick(TIER1), replicas = int(4, 12);
    return { label: 'ticket', rule: 'one pod failing while the service serves traffic normally', hard: true, alert: { alertname: 'KubePodCrashLooping', env: 'production', service, severity: severity('ticket', mis), status: 'firing',
      summary: `Pod ${service}-${int(1000, 9999).toString(16)} is crash looping`,
      description: `1 of ${replicas} ${service} pods has restarted ${int(5, 30)} times in the last hour (OOMKilled). The other ${replicas - 1} replicas are healthy and the service error ratio is ${pct(between(0.01, 0.2, 2))}.` } };
  },
  t_node(mis) {
    const n = int(8, 24);
    return { label: 'ticket', rule: 'one node failing while the service serves traffic normally', alert: { alertname: 'KubeNodeNotReady', env: 'production', service: 'kubernetes', severity: severity('ticket', mis), status: 'firing', team: 'platform',
      summary: `Node worker-${int(10, 99)} NotReady`,
      description: `1 of ${n} worker nodes has been NotReady for ${int(10, 40)} minutes (kubelet stopped posting status). Its pods were rescheduled on other nodes; no service reports errors.` } };
  },
  t_backup(mis) {
    const db = pick(['postgres-main', 'postgres-orders']);
    return { label: 'ticket', rule: 'backup or scheduled job failed', alert: { alertname: 'BackupJobFailed', env: 'production', service: db, severity: severity('ticket', mis), status: 'firing', team: 'platform',
      summary: `Nightly backup of ${db} failed`,
      description: `The nightly pg_basebackup job for ${db} exited with code 1 (${pick(['S3 upload timed out', 'disk quota exceeded on the backup host', 'authentication failed for the backup role'])}). The last successful backup was ${int(25, 30)} hours ago.` } };
  },
  t_cron(mis) {
    const job = pick(['monthly-invoice-export', 'sitemap-rebuild', 'stale-cart-cleanup', 'search-reindex-nightly']);
    return { label: 'ticket', rule: 'backup or scheduled job failed', alert: { alertname: 'CronJobFailed', env: 'production', service: pick(['reporting', 'search', 'storefront']), severity: severity('ticket', mis), status: 'firing',
      summary: `CronJob ${job} failed`,
      description: `The Kubernetes CronJob ${job} failed its last run (BackoffLimitExceeded). The previous run succeeded. The job is retried on its next schedule.` } };
  },
  t_staging_release(mis) {
    const service = pick(TIER1), release = `2026.10.${int(2, 9)}`;
    return { label: 'ticket', rule: 'staging problem that blocks a release', hard: true, alert: { alertname: 'EndpointDown', env: 'staging', service, severity: severity('ticket', mis), status: 'firing',
      summary: `${service} health check failing in staging`,
      description: `Blackbox probe to https://${service}.staging.internal/healthz has failed for ${int(10, 50)} minutes. This blocks release ${release}, which is waiting on the staging smoke tests.` } };
  },
  t_down_tier2(mis) {
    const service = pick(TIER2);
    return { label: 'ticket', rule: 'tier 2 service down in production', alert: { alertname: 'EndpointDown', env: 'production', service, severity: severity('ticket', mis), status: 'firing',
      summary: `${service} health check failing from all probe locations`,
      description: `Blackbox probe to https://${service}.internal/healthz has failed from 3 of 3 locations for ${int(3, 30)} minutes. Last error: ${pick(['connection refused', 'HTTP 502', 'timeout after 10s'])}.` } };
  },

  // ---------- ignore ----------
  i_watchdog() {
    return { label: 'ignore', rule: 'informational heartbeat', alert: { alertname: 'Watchdog', env: 'production', service: 'alertmanager', severity: 'none', status: 'firing', team: 'platform',
      summary: 'Alerting pipeline heartbeat', description: 'This alert is always firing. It proves the whole alerting pipeline works. It is meant for a dead man\'s switch, not for people.' } };
  },
  i_deploy() {
    const service = pick([...TIER1, ...TIER2]);
    return { label: 'ignore', rule: 'informational deploy notification', alert: { alertname: 'DeploymentRolledOut', env: 'production', service, severity: 'info', status: 'firing',
      summary: `${service} rolled out version ${int(100, 400)}`, description: `Deployment ${service} finished rolling out: ${int(3, 12)} of ${int(3, 12)} pods updated and ready.` } };
  },
  i_hpa() {
    const service = pick(TIER1), from = int(4, 8);
    return { label: 'ignore', rule: 'informational autoscaling event', alert: { alertname: 'HPAScaledUp', env: 'production', service, severity: 'info', status: 'firing',
      summary: `${service} scaled from ${from} to ${from + int(2, 6)} replicas`, description: `The HorizontalPodAutoscaler for ${service} added replicas because CPU utilization reached ${int(71, 85)}% (target 70%). Latency and errors are normal.` } };
  },
  i_nonprod(mis) {
    const env = pick(NONPROD), service = pick(TIER1), ratio = between(5, 60, 1);
    return { label: 'ignore', rule: 'non-production environment, no release blocked', hard: true, alert: { alertname: 'HighErrorRate', env, service, severity: mis ? 'critical' : 'warning', status: 'firing',
      summary: `${service} 5xx ratio is ${pct(ratio)} in ${env}`,
      description: `5xx responses on ${service} in ${env} have been above 2% for ${int(5, 40)} minutes. Current value ${pct(ratio)}. No release is waiting on this environment.` } };
  },
  i_flap(mis) {
    const service = pick(TIER1), mins = int(1, 4);
    const start = startsAt(), end = new Date(Date.parse(start) + mins * 60_000).toISOString().replace('.000', '');
    return { label: 'ignore', rule: 'resolved by itself within 5 minutes with no customer impact', hard: true, startsAt: start, alert: { alertname: 'EndpointDown', env: 'production', service, severity: mis ? 'critical' : 'warning', status: 'resolved', endsAt: end,
      summary: `${service} health check recovered`,
      description: `The blackbox probe to https://${service}.internal/healthz failed from 1 of 3 locations and recovered after ${mins} minutes. The service error ratio stayed at ${pct(between(0.01, 0.1, 2))} the whole time; no customer-facing errors were recorded.` } };
  },
  i_maintenance(mis) {
    const which = pick(['primary', 'errors']);
    const db = pick(['postgres-main', 'postgres-orders']);
    const change = `CHG-${int(4000, 4999)}`;
    const window = `active until ${String(int(2, 5)).padStart(2, '0')}:00 UTC, change ${change} (${which === 'primary' ? 'major version upgrade of ' + db : 'checkout database migration'})`;
    if (which === 'primary') {
      return { label: 'ignore', rule: 'active maintenance window', hard: true, alert: { alertname: 'PostgresPrimaryUnreachable', env: 'production', service: db, severity: mis ? 'critical' : 'warning', status: 'firing', team: 'platform', maintenance: window,
        summary: `${db} primary not responding`, description: `The primary of ${db} has not answered health checks for ${int(2, 9)} minutes.` } };
    }
    return { label: 'ignore', rule: 'active maintenance window', hard: true, alert: { alertname: 'HighErrorRate', env: 'production', service: 'checkout', severity: mis ? 'critical' : 'warning', status: 'firing', maintenance: window,
      summary: `checkout 5xx ratio is ${pct(between(3, 12, 1))}`, description: `5xx responses on checkout have been above 2% for ${int(5, 15)} minutes.` } };
  },
  i_decommissioned(mis) {
    const target = pick(['search-v1-legacy', 'storefront-old', 'payments-sandbox-2024', 'auth-v1']);
    return { label: 'ignore', rule: 'decommissioned target', hard: true, alert: { alertname: 'EndpointDown', env: 'production', service: target, severity: mis ? 'critical' : 'warning', status: 'firing', extraLabels: { decommissioned: 'true' },
      summary: `${target} health check failing from all probe locations`,
      description: `Blackbox probe to https://${target}.internal/healthz has failed from 3 of 3 locations for ${int(30, 600)} minutes. The target was decommissioned on 2026-09-${String(int(10, 30)).padStart(2, '0')} and its probe was never removed.` } };
  },
  i_nonprod_cert(mis) {
    const env = pick(['dev', 'sandbox', 'preview']), hours = int(2, 20);
    return { label: 'ignore', rule: 'non-production environment, no release blocked', hard: true, alert: { alertname: 'TLSCertificateExpiringSoon', env, service: 'edge', severity: mis ? 'critical' : 'warning', status: 'firing', team: 'platform',
      summary: `Certificate for ${env}.example.dev expires in ${hours} hours`,
      description: `The certificate served on ${env}.example.dev:443 expires in ${hours} hours. Only internal testers use this host.` } };
  },
  i_test_target(mis) {
    return { label: 'ignore', rule: 'known test target', hard: true, alert: { alertname: 'SyntheticCheckFailing', env: 'production', service: 'synthetic-canary', severity: mis ? 'critical' : 'warning', status: 'firing', extraLabels: { target: 'canary-test-target', test: 'true' },
      summary: 'Synthetic check against canary-test-target failing',
      description: 'The synthetic check against canary-test-target, a known test target that the monitoring team breaks on purpose to test alert routing, has failed for 12 minutes.' } };
  },
};

// How many of each scenario, and how often the severity label points the wrong way.
const PLAN = [
  ...['p_error_rate', 'p_latency', 'p_down', 'p_burn_fast', 'p_disk', 'p_conns', 'p_cert', 'p_primary', 'p_security', 'p_redis_mem'].map((s) => [s, 5, 0.3]),
  ...['t_error_tier2', 't_error_below', 't_latency_below', 't_burn_slow', 't_disk_days', 't_cert_days', 't_crashloop_one', 't_node', 't_backup', 't_cron', 't_staging_release', 't_down_tier2'].map((s) => [s, 7, 0.3]),
  ['i_watchdog', 4, 0], ['i_deploy', 4, 0], ['i_hpa', 4, 0],
  ['i_nonprod', 8, 0.5], ['i_flap', 8, 0.5], ['i_maintenance', 8, 0.6], ['i_decommissioned', 8, 0.5],
  ['i_nonprod_cert', 8, 0.5], ['i_test_target', 7, 0.5], ['i_nonprod', 7, 0.5],
];

const rows = [];
for (const [name, n, misRate] of PLAN) {
  for (let i = 0; i < n; i++) {
    const mis = chance(misRate);
    const s = scenarios[name](mis);
    const a = { team: TEAMS[s.alert.service], ...s.alert };
    a.startsAt = s.startsAt ?? startsAt();
    // A maintenance alert must start inside its window. The first version did
    // not check, and two alerts started after "active until 04:00 UTC" had
    // passed, so the label said ignore while the text said page. Most models
    // caught it; the second reader did not. Moving the start time draws no
    // random numbers, so every other alert stays the same.
    const until = a.maintenance?.match(/until (\d{2}):00 UTC/);
    if (until) {
      const end = Number(until[1]), d = new Date(a.startsAt);
      if (d.getUTCHours() >= end && d.getUTCHours() < 12) {
        d.setUTCHours(end - 1);
        a.startsAt = d.toISOString().replace('.000', '');
      }
    }
    const severityMismatch = a.severity !== 'none' && a.severity !== SEVERITY_FOR[s.label];
    rows.push({ scenario: name, label: s.label, rule: s.rule, hard: Boolean(s.hard) || severityMismatch, severityMismatch, alert: a, text: render(a) });
  }
}

const out = shuffle(rows).map((r, i) => ({ id: `a${String(i + 1).padStart(3, '0')}`, ...r }));
writeFileSync(new URL('../data/alerts.jsonl', import.meta.url), out.map((r) => JSON.stringify(r)).join('\n') + '\n');

const count = (f) => out.filter(f).length;
console.log(`alerts: ${out.length}`);
for (const l of ['page', 'ticket', 'ignore']) console.log(`  ${l.padEnd(6)} ${count((r) => r.label === l)} (hard ${count((r) => r.label === l && r.hard)})`);
console.log(`  severity label points the wrong way: ${count((r) => r.severityMismatch)}`);
