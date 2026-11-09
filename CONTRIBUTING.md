# Contributing

Small, focused pull requests are welcome. Include the behavior being fixed, a reproducible example and relevant validation.

## Local workflow

1. Install Node.js 22.13+ and run `npm ci`.
2. Run `npm run demo` for an offline classification example.
3. Implement the change with synthetic fixtures for behavior that can regress.
4. Run `npm run typecheck`, `npm test`, `npm run build` and `npm run format:check`.
5. For queue/database changes, run both integration scenarios with separate disposable test databases as described in the README.

Keep the service boundaries in `services/` and reusable contracts in `packages/`. Schema changes go in a new numbered migration; do not edit migrations already deployed.

## Working with LinkedIn

Follow [AGENTS.md](AGENTS.md) and [traffic protection](docs/TRAFFIC_PROTECTION.md). Do not issue live requests to debug a parser if a saved sanitized fixture or synthetic response is sufficient. All live requests must use the shared durable protection layer. A restart must never erase holds or quotas.

Never commit `.env`, `.local`, cookies, tokens, captured account pages, message contents or real user data. Redact screenshots and logs before sharing them. Report security-sensitive issues privately through [SECURITY.md](SECURITY.md).

## Pull requests

Describe the problem, resulting behavior and tests. For parser changes, include a minimal synthetic fixture for the relevant structure and explicitly describe what remains unverified against live responses. Avoid presenting a synthetic test as proof of complete LinkedIn coverage.
