# Documentation

## Current guides

- [Production setup](PRODUCTION.md): local sessions, dry-run, Telegram and deployment.
- [LinkedIn adapter](LINKEDIN_ADAPTER.md): surfaces, configuration and parsing limits.
- [Global search](GLOBAL_SEARCH.md): post discovery and pagination.
- [Architecture](ARCHITECTURE.md): service boundaries, persistence and guarantees.
- [Traffic protection](TRAFFIC_PROTECTION.md): quotas, cooldowns and recovery.
- [Logging](LOGGING.md): rotated files and diagnostic reports.
- [Runbook](RUNBOOK.md): operational procedures; consult the protection guide for current recovery commands.

## Historical engineering records

The following files preserve decisions and reviews at specific points in development. Statements about implementation status, live access or local runtime in these records are historical, not current product guarantees:

- [Work log](WORKLOG.md)
- [Initial handoff](HANDOFF.md)
- [Open questions](OPEN_QUESTIONS.md)
- [Initial review](CLAUDE_REVIEW.md) and [recheck](CLAUDE_RECHECK.md)
- [Review response](REVIEW_RESPONSE.md)
- [Functional review](FUNCTIONAL_REVIEW.md)
- [Functional fixes](FIXES_2026-11-08.md)

The README and current guides describe supported behavior. A running deployment's `/status` and file logs describe its actual state.
