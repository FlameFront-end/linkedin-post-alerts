<div align="center">

# LinkedIn Post Alerts

**Find hiring posts in your LinkedIn feed. Get relevant vacancies in Telegram.**

[![Checks](https://github.com/FlameFront-end/linkedin-post-alerts/actions/workflows/checks.yml/badge.svg)](https://github.com/FlameFront-end/linkedin-post-alerts/actions/workflows/checks.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Self-hosted · PostgreSQL queue · Telegram alerts · Russian-language matching

[Quick start](#quick-start) · [Live setup](docs/PRODUCTION.md) · [Traffic protection](docs/TRAFFIC_PROTECTION.md) · [Logs](docs/LOGGING.md) · [Contributing](CONTRIBUTING.md)

</div>

## Why posts?

Recruiters often announce roles as ordinary LinkedIn posts without creating a Jobs listing. This service reads the personal feed and searches **Posts**, then classifies vacancies and sends compact Telegram cards. Native Jobs collection is an optional, separate source.

The current matching profile favors **frontend, full-stack and related interface development**, with Russian text or an explicit requirement to speak Russian. Rules are intentionally broad: some adjacent roles can pass, and complex wording can still be missed. DevOps is excluded from live alerts.

## What it does

- Refreshes the feed and follows supported server-issued pagination, including repost text.
- Searches posts globally by configurable keywords; a recruiter list is optional.
- Extracts Russian/English text from supported images using an isolated Tesseract service.
- Separates positions in vacancy roundups and evaluates language requirements per position.
- Tracks edits and suppresses duplicates using post identity, specific application links and identical long text.
- Delivers HTML Telegram cards with available salary, location, work format and language evidence.
- Persists request quotas, cooldowns, queue leases and vacancy history in PostgreSQL.
- Writes rotated JSONL logs with correlation IDs and redaction of sensitive fields.

**Status:** actively developed and used against live responses. LinkedIn's private response formats can change; complete coverage and uninterrupted access are not guaranteed. Unrecognized pagination is reported explicitly. Account restrictions and HTTP 429 are real operational constraints, including for public Jobs endpoints. See [known limitations](#known-limitations).

## Quick start

Requires Node.js **22.13+**, npm, Docker and Docker Compose. No LinkedIn or Telegram credentials are needed for the demo.

```sh
git clone https://github.com/FlameFront-end/linkedin-post-alerts.git
cd linkedin-post-alerts
npm ci
npm run demo
```

Run the complete local stack with mock posts and dry-run delivery:

```sh
cp .env.example .env
npm run logs:init
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose up --build -d
```

The UID/GID command is for macOS/Linux. On other systems, set those variables to the UID/GID that can write the mounted log directories. The OCR image installs Tesseract during its first build.

| Service    | Local endpoint                       | Purpose                                     |
| ---------- | ------------------------------------ | ------------------------------------------- |
| Collector  | `http://localhost:3101/status`       | Sources, protection state and queue summary |
| Collector  | `http://localhost:3101/health/ready` | Collection readiness                        |
| Processor  | `http://localhost:3102/health/ready` | Classification worker readiness             |
| Notifier   | `http://localhost:3103/health/ready` | Delivery readiness                          |
| PostgreSQL | `localhost:55432`                    | Local database                              |
| OCR        | Internal port `3104`                 | Image text extraction                       |

The default Compose credentials are for a local development database. Configure database access appropriately before exposing a deployment. `docker compose down` preserves the database volume; `down -v` removes it.

## Connect LinkedIn and Telegram

Follow [the live setup guide](docs/PRODUCTION.md) for local session files, search configuration and Compose overlays. Credentials belong in `.env` and `.local/`, both ignored by Git. Never paste session cookies into an issue, pull request or log.

The adapter uses HTTP requests, without Playwright or a paid scraping provider. It relies on account-accessible, undocumented LinkedIn responses rather than an official supported API. Use only where you have authorization and comply with the platform's terms and applicable requirements.

## Collection cadence and protection

| Source            | Default cadence  | Additional behavior                                        |
| ----------------- | ---------------- | ---------------------------------------------------------- |
| Feed refresh      | Every 5 minutes  | Refreshes the top of the feed                              |
| Deeper feed pages | Every 15 minutes | Separately scheduled, bounded by the request budget        |
| Post search       | Every 30 minutes | Rotates queries and checks fresh pages before deeper pages |
| Native Jobs       | At most hourly   | Optional; held after a 429 until explicit recovery         |

All sources share rolling limits: **20 requests/hour and 150/day** by default. Search is further limited to **4/hour and 20/day**. Requests are spaced by at least 20 seconds. These are application limits, **not LinkedIn-published safe thresholds**. Quotas can make actual collection less frequent than the schedule.

Restrictions survive container restarts. The service does not rotate accounts, evade challenges or reset quotas to continue collection. [Protection and recovery details →](docs/TRAFFIC_PROTECTION.md)

## Architecture

```text
LinkedIn feed / post search / optional Jobs
                    │
                Collector
                    │
         PostgreSQL durable queue
                    │
                Processor ─── OCR (Tesseract rus + eng)
                    │
        Vacancy history + notification queue
                    │
                 Notifier
                    │
                 Telegram
```

Four application services run as separate processes and containers in a TypeScript monorepo. PostgreSQL provides the durable queue, transactional processing, shared traffic protection and history. There is no Redis or hosted AI dependency.

```text
services/   collector · processor · notifier · ocr
packages/   contracts · queue · runtime
config/     credential-free configuration examples
migrations/ versioned PostgreSQL schema
scripts/    diagnostics, audit, replay and log reports
tests/      unit and PostgreSQL integration scenarios
docs/       setup, architecture, operations and historical reviews
```

[Architecture and delivery guarantees →](docs/ARCHITECTURE.md)

## Development

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

Integration tests require **two disposable databases**. They recreate the `queue` and `processing` schemas and require database names ending in `_test`:

```sh
TEST_DATABASE_URL=postgres://alerts:alerts@localhost:55432/alerts_test \
TEST_FUNCTIONAL_DATABASE_URL=postgres://alerts:alerts@localhost:55432/alerts_functional_test \
  npm run test:integration
```

Both databases must already exist. Never use the application database. CI creates its own databases; tests use synthetic responses and do not access LinkedIn or Telegram.

## Diagnostics

```sh
npm run linkedin:check   # Saved protection state; no LinkedIn requests
npm run logs:report      # All retained JSONL files + local status summary
npm run posts:audit      # Preview classification of stored posts
```

File logs live under `.local/logs/`, rotate at 5 MiB and are retained for seven days. Reports include recent warnings/errors and malformed records. Logging begins when installed; it cannot reconstruct earlier events. [Logging reference →](docs/LOGGING.md)

## Known limitations

- The feed is personalized; search visibility and ranking are controlled by LinkedIn.
- Only recognized pagination formats are followed. Missing continuation does not prove that all results were collected.
- Rule-based matching and OCR can produce false positives and false negatives. There is no measured recall claim.
- Images without a usable content URL/post identity and video-only vacancies are not fully covered.
- Telegram delivery is at-least-once: a crash between a successful external send and database acknowledgement can still duplicate a message.
- Public Jobs endpoints may return 429 even with low request volume.

## Documentation

| Guide                                            | Contents                                        |
| ------------------------------------------------ | ----------------------------------------------- |
| [Live setup](docs/PRODUCTION.md)                 | Sessions, dry-run, Telegram and Docker overlays |
| [LinkedIn adapter](docs/LINKEDIN_ADAPTER.md)     | Configuration and supported response surfaces   |
| [Global post search](docs/GLOBAL_SEARCH.md)      | Discovery and pagination behavior               |
| [Traffic protection](docs/TRAFFIC_PROTECTION.md) | Quotas, persistent holds and recovery           |
| [Logging](docs/LOGGING.md)                       | File locations, rotation and reports            |
| [Architecture](docs/ARCHITECTURE.md)             | Boundaries, queue and delivery guarantees       |
| [Documentation index](docs/README.md)            | Operations and historical reviews               |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for private vulnerability reporting. Please use synthetic, sanitized fixtures rather than real account data.

## License

[MIT](LICENSE). This project is independent and is not affiliated with or endorsed by LinkedIn or Telegram.
