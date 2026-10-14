# On-call routing policy

Every alert gets exactly one decision: **page**, **ticket** or **ignore**.

## Services

Tier 1 (customer-facing): `checkout`, `payments`, `api-gateway`, `auth`, `search`, `storefront`.
Tier 2 (internal): every other service, for example `ci-runners`, `admin-dashboard`, `reporting`, `email-digest`, `image-resizer`, `feature-flags`.

## Page: wake someone now

Page only when the alert is in **production** and there is customer impact now, or there will be within 1 hour:

- a tier 1 service is down, or returns errors on more than 2% of requests for 5 minutes or more, or its p99 latency is above 2 seconds for 10 minutes or more
- a tier 1 SLO burns its error budget at 14x or faster
- a production database, cache or queue will run out of disk, memory or connections within 1 hour at the current rate
- a public production TLS certificate expires in less than 24 hours
- the production primary database is unreachable
- a security detector reports confirmed unauthorized access in production

## Ticket: fix it during business hours

A real problem with no customer impact within the hour:

- a tier 2 service in production is down or returning errors
- a tier 1 problem below the page thresholds (for example 1.2% errors, p99 of 1.4 seconds, or an SLO burn below 14x)
- capacity that runs out in more than 1 hour but less than 7 days
- a TLS certificate that expires in 1 to 14 days
- one pod, node or instance is failing while the service still serves traffic normally
- a backup or scheduled job failed
- a problem in staging that blocks a release

## Ignore: no action

- non-production environments (dev, sandbox, preview, staging), unless the alert says it blocks a release
- the alert resolved by itself within 5 minutes and had no customer impact
- informational alerts: heartbeats such as Watchdog, deploy notifications, autoscaling events
- the service is in an active maintenance window
- the target is decommissioned or is a known test target

## Precedence

An active maintenance window or a decommissioned target means **ignore**, even when the alert would otherwise page.
The `severity` label is set by whoever wrote the alert rule. Treat it as a hint only and decide from the rules above.
