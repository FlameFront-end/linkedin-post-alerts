# Discovering vacancies in posts

No recruiter list is required. The personal feed and keyword search are complementary: the feed is personalized, while Posts search discovers account-visible results across queries. Neither provides complete coverage of LinkedIn.

## Discovery pipeline

1. Refresh the feed top on its own schedule, with deeper pages on a slower schedule.
2. Rotate configurable Posts queries. Check fresh first pages before spending remaining budget on deeper results.
3. Normalize IDs, available text, dates and author metadata. Where supported, hydrate incomplete text and preserve repost content.
4. Persist observations and new post versions in the durable queue.
5. Classify each position, optionally extract image text, deduplicate vacancies and notify Telegram.

The current live matching profile is frontend/full-stack/interface-related work with Russian text or mandatory Russian. DevOps is excluded. This profile is implemented in `packages/contracts/src/`; it is heuristic rather than an AI relevance score.

## Search configuration

`keywords` and `searchPathTemplate` live in `.local/linkedin.json`. Use a current request from the Posts interface; query IDs and server formats can change. The [adapter guide](LINKEDIN_ADAPTER.md) documents supported paths and placeholders.

Normalized search cards are discovery references: summaries are not treated as complete vacancy descriptions. HTML cards include available text directly; truncated text is marked and hydrated when supported and within budget.

## Pagination and coverage

- Normalized responses use server paging metadata.
- HTML/streaming responses use supported server continuations or validated same-host next links.
- An explicit disabled Next control marks the end of results.
- No recognized continuation means **unknown coverage**, not proof that more results exist or that collection is complete.
- Per-cycle budgets and persistent quotas can stop a run even when more pages exist. This is expected protective behavior.

The `/status` endpoint and JSONL logs report target status, discovered cards and available pagination state. Account restrictions are separate from coverage warnings. Do not increase requests or guess pagination tokens to conceal a missing parser.

## Optional native Jobs

Jobs uses public guest endpoints without member cookies, but participates in the same traffic protection budget. It prioritizes unseen cards, performs bounded refreshes and defers unavailable cards. A Jobs 429 places that source on hold until explicit recovery; the shared cooldown is still respected.

See [production setup](PRODUCTION.md), [traffic protection](TRAFFIC_PROTECTION.md) and [logging](LOGGING.md).
