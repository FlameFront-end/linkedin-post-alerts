# Architecture and guarantees

## Services

| Service   | Responsibility                                                                                            | Dependencies         |
| --------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| Collector | Fetch account-accessible feed/search responses and optional Jobs; normalize posts; reserve traffic budget | LinkedIn, PostgreSQL |
| Processor | Classify each position, enrich supported images, update vacancy history, enqueue alerts                   | PostgreSQL, OCR      |
| Notifier  | Recheck relevance/current revision, format Telegram cards, deliver and acknowledge                        | PostgreSQL, Telegram |
| OCR       | Download allowed LinkedIn content images and run Tesseract `rus+eng`                                      | Image CDN, Tesseract |

Each service has a separate process/container and health endpoints. Shared TypeScript packages provide contracts, the PostgreSQL queue and runtime utilities. The services share one database; this is a self-hosted deployment rather than independently owned database-per-service infrastructure.

## Persistent pipeline

Collector writes a post version into `queue.jobs`. Processor transactionally stores the assessment, updates vacancy history, enqueues notifications and completes the original job. A processing failure rolls back that transaction.

The queue uses `FOR UPDATE SKIP LOCKED`, expiring leases and a unique lock token per claim. An old worker cannot acknowledge a new worker's lease. Retryable processing failures use delayed retries; exhausted jobs remain `dead` for inspection. Temporary Telegram outages pause the sender without consuming every message's attempt budget.

## Identity, edits and duplicates

Observations track a fingerprint per post ID. A changed version is reconsidered; stale queued versions can be skipped. Explicit multi-position headings are separated so that closure or language requirements do not automatically apply to neighboring roles.

Vacancy aliases merge strong matches: the source identity, a specific LinkedIn Jobs ID, a job-specific application link or identical long normalized text. Shared email addresses, home pages and generic short links are not enough. This is conservative deduplication, not general semantic entity resolution.

Pending notifications are suppressed when their revision is superseded or the vacancy is no longer open. Delivery receipts record successful sends and allow acknowledgement retries without immediately sending again.

**External delivery is at-least-once.** There remains a crash window between Telegram accepting a message and PostgreSQL recording it. Exactly-once delivery is not promised.

## Traffic protection

All live HTTP requests go through a shared PostgreSQL-backed protection store, with transactional quota reservation and a request lease. Feed, search, details, pagination, Jobs and explicit diagnostics share the budget. Per-source holds, global cooldowns and rolling hourly/daily counters survive restart.

An unavailable protection database blocks the request. Quotas, server Retry-After and manual holds are never bypassed to complete a cycle. See [traffic protection](TRAFFIC_PROTECTION.md).

Feed refresh, deeper feed pagination, post search and Jobs have separate schedules. The scheduler avoids overlapping runs of one task and does not create a burst to catch up missed intervals.

## Classification and OCR

The live profile accepts Russian frontend/full-stack/interface-related vacancies, or English vacancies with a mandatory Russian requirement. It rejects explicit candidate posts, promotions and closed positions using rules. Classification is heuristic: no measured recall or perfect language understanding is claimed.

OCR is isolated from member cookies and Telegram credentials. It accepts bounded images from allowed LinkedIn content URLs, rejects redirects and records text extraction metadata. Text-only and image content can still be missed when the source shape is unsupported.

## Observability and storage

Structured JSONL logs use per-cycle and per-request IDs; post/job/vacancy IDs connect events across services. Secret fields, raw payloads and response bodies are excluded. Docker and file logs rotate. `/status` reports source health, quotas, queue counts and measured delivery timing.

Logs and credentials stay in ignored local directories. Completed jobs/history are retained for a bounded period; database volumes survive ordinary container restarts. Dry-run acknowledges jobs too, so changing to live mode does not automatically replay them.
