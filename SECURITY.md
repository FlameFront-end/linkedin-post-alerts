# Security policy

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/FlameFront-end/linkedin-post-alerts/security/advisories/new). Include the affected commit, reproduction steps, impact and a minimal sanitized example. Do not post credentials, session cookies or account-specific captures in a public issue.

The current `main` branch is maintained. There is no promised response-time SLA.

## Deployment considerations

- Session files and Telegram credentials stay in `.local/` and `.env`; neither belongs in Git.
- Session files must have mode `600`. Logs redact sensitive fields but should still be treated as operational data.
- Collector, processor, notifier and OCR use separate containers; only collector receives the LinkedIn session mount.
- Local Compose database credentials are development defaults. Keep database and health/status ports private and configure credentials for your deployment.
- Do not disable persistent request protection to work around platform restrictions.
