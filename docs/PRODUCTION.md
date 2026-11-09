# Live setup and operations

Start with the offline demo and mock Compose stack in the [README](../README.md). This guide enables real sources. The LinkedIn adapter is experimental and can encounter account restrictions or response-format changes.

## 1. Prepare local files

```sh
npm ci
cp .env.example .env
npm run logs:init
cp config/linkedin.example.json .local/linkedin.json
cp config/session.example.json .local/session.json
chmod 600 .local/session.json
```

Fill `.local/session.json` locally with `liAt` and `jsessionId`, corresponding to the browser cookies `li_at` and `JSESSIONID`. The optional `csrfToken` and `userAgent` must match the same session. Do not share these values or commit captured responses.

Configure `.local/linkedin.json` using the [adapter guide](LINKEDIN_ADAPTER.md). For the feed, set `personalFeed: true`. If keyword search is configured, `searchPathTemplate` must match the current Posts request visible to your account. Remove keyword entries if you want a feed-only deployment.

## 2. Configure the environment

Set these values in `.env`:

```dotenv
SOURCE_MODE=linkedin
TELEGRAM_MODE=dry-run
POLL_INTERVAL_MS=1800000
FEED_POLL_INTERVAL_MS=300000
COLLECTION_PAUSED=true
TELEGRAM_BOT_TOKEN=YOUR_LOCAL_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_LOCAL_CHAT_ID
```

The production overlay requires a Telegram token and chat ID even when dry-run is selected. Alternatively, start with the base and LinkedIn overlays only; workers remain in mock/dry-run configuration until the production overlay is added.

Use development Compose credentials only on a private local host. Do not expose the database or `/status` publicly. The base stack uses PostgreSQL user/password/database `alerts`; configure all database connections consistently if changing those credentials.

## 3. Start the paused stack

```sh
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose \
  -f compose.yaml -f compose.linkedin.yaml -f compose.prod.yaml up --build -d
```

File logs are mounted under `.local/logs/`. The collector exposes `http://localhost:3101/status`; readiness is intentionally unavailable while collection is paused. Workers and OCR have independent health checks.

## 4. Check one source

`npm run linkedin:check` reads saved protection state from PostgreSQL and does **not** contact LinkedIn. `.env` must point to the same database as the collector; the local example uses `localhost:55432`.

When no restriction is active, one protected feed request can be made explicitly:

```sh
npm run linkedin:check -- --probe feed
```

For keyword search use `--probe search`. A successful empty response is a valid transport/parser check, not proof that the chosen query finds suitable vacancies. Compare sample dates/text against the ordinary interface before relying on a new adapter configuration.

If there is a saved restriction, follow [traffic protection and recovery](TRAFFIC_PROTECTION.md). Only use a confirmed probe after the owner has verified that the same surface works normally in the browser. Neither a restart nor a diagnostic command resets budgets or cooldowns.

## 5. Enable collection, then delivery

After a successful protected check, set `COLLECTION_PAUSED=false` and recreate collector:

```sh
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose \
  -f compose.yaml -f compose.linkedin.yaml -f compose.prod.yaml \
  up -d --no-deps --force-recreate collector
```

Review `.local/logs/`, `/status` and `npm run logs:report`. Dry-run deliveries acknowledge notification jobs; they will not automatically be resent after switching to live delivery.

To enable Telegram, set `TELEGRAM_MODE=live` and recreate notifier with the same Compose overlays. The bot must be able to send to the configured chat. Incorrect credentials pause delivery and preserve the backlog.

## Recovery and limitations

- Native Jobs is optional and uses public guest endpoints without member cookies. After a 429 it is held until explicit recovery; feed and post search may resume after the shared cooldown.
- Unknown HTML/stream formats can stop a source. Fix parsing against a sanitized fixture rather than repeatedly probing LinkedIn.
- Partial search pagination is reported; it does not mean that the account is blocked.
- Review old jobs using `npm run queue:replay -- notification ID` and apply deliberately with `--apply` when appropriate.
- Retention removes completed history after `RETENTION_DAYS`; default 30 days. PostgreSQL volume persists across ordinary restarts.
- Delivery is at-least-once. An external send followed by a crash before acknowledgement can still duplicate a message.

See [logging](LOGGING.md), [architecture](ARCHITECTURE.md) and [traffic protection](TRAFFIC_PROTECTION.md).
