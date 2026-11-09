# Operational runbook

Use [production setup](PRODUCTION.md) for credentials and live deployment. Commands below run from the repository root. Supply the same Compose overlays and UID/GID variables used for your deployment when recreating an application container.

## Inspect without contacting LinkedIn

```sh
npm run linkedin:check
npm run logs:report
docker compose ps
docker compose logs --tail=50 collector processor notifier ocr
```

`linkedin:check` reads PostgreSQL protection state; `logs:report` reads retained files and local `/status`. Neither sends a LinkedIn request. The collector's `/status` describes source health, disabled sources, quotas and queue counts. Liveness only proves the process exists; readiness also checks dependencies/current source state.

## Inspect the queue

```sh
docker compose exec postgres psql -U alerts -d alerts \
  -c "SELECT kind,status,count(*) FROM queue.jobs GROUP BY kind,status ORDER BY kind,status"
```

Investigate `dead` jobs before replay. Preview one job, then deliberately apply:

```sh
npm run queue:replay -- notification ID
npm run queue:replay -- notification ID --apply
```

Do not reset the whole queue or traffic-protection record. Dry-run acknowledges notifications; switching to live mode does not replay those deliveries automatically. Stale incident alerts and superseded vacancy revisions may be suppressed even after replay.

## Pause collection

Set `COLLECTION_PAUSED=true` in `.env`, then recreate collector with the deployment overlays. Workers can continue processing the existing queue. Readiness remains unavailable while collection is intentionally paused.

## LinkedIn failures

- Search suspension: keep that source held. Once the owner confirms ordinary search works, follow the one-request procedure in [traffic protection](TRAFFIC_PROTECTION.md).
- Authentication/challenge: confirm ordinary account access and update local session data if needed. Restarting alone does not clear the durable hold.
- 429: retain the cooldown. Jobs stays quarantined after its first 429 until explicit recovery.
- Unknown format: inspect parser event codes and a minimal sanitized fixture; avoid repeated live probes.
- Coverage warning: pagination may be unknown or unsupported. This is different from a blocked account.

## Telegram and OCR

Incorrect Telegram credentials or transient provider failures pause the sender while preserving backlog. Correct configuration and recreate notifier. Alerts use the same sender, so a Telegram outage can also delay operational notifications.

OCR has no member cookies or bot token. Check its health and `extract_failed` events if image enrichment fails. It has bounded resource, image size and timeout limits.

## Data and logs

- `docker compose down` preserves the database volume; `down -v` deletes it.
- Completed jobs and assessments are cleaned up after `RETENTION_DAYS`, default 30 days.
- `.local/logs` persists on the host. Logs rotate and redact sensitive fields; see [logging](LOGGING.md).
- A `log_file_failed` entry in Docker stderr means file logging has a gap, commonly due to permissions or disk space.
- Do not expose local database/status ports or enable raw header/body logging for troubleshooting.

## Integration checks

Create two separate disposable databases with names ending in `_test` and run the command in the README. Tests recreate the `queue` and `processing` schemas. Never point either variable at the application database.
