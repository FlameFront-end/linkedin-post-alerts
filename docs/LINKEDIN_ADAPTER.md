# LinkedIn adapter

The collector uses HTTP requests rather than browser automation. It depends on undocumented, account-accessible response formats and may stop working when LinkedIn changes them. [Production setup](PRODUCTION.md) covers deployment; [traffic protection](TRAFFIC_PROTECTION.md) covers quotas and recovery.

## Session

Copy `config/session.example.json` to `.local/session.json` and set mode `600`. Populate locally:

| Field        | Meaning                                             |
| ------------ | --------------------------------------------------- |
| `liAt`       | Browser `li_at` cookie                              |
| `jsessionId` | Browser `JSESSIONID` cookie                         |
| `csrfToken`  | Optional explicit CSRF header from the same session |
| `userAgent`  | Optional actual User-Agent of that browser session  |

Only collector receives the session mount. Host checks are fixed, redirects are not followed and headers/session values are not logged. Never attach a raw account page or session file to a public issue.

## Configuration

Start from `config/linkedin.example.json`:

- `personalFeed`: refresh the personal feed. `personalFeedLoadMore` bounds additional pages.
- `feedDeepIntervalMs`: separate schedule for deeper pagination, default 15 minutes.
- `keywords`: post search queries. Set `searchPathTemplate` when the list is non-empty.
- `searchPathTemplate`: a current relative Posts request path, captured from your account. HTML paths start `/search/results/content/?` and require `{keywords}`. Voyager paths require `{keywords}`, `{start}` and `{count}`.
- `postPathTemplate`: relative detail request, using `{urn}` or `{slug}`. A historical query ID is not evidence that an endpoint still works.
- `authorUrns`: optional profile URNs. A recruiter list is not required for feed/global search.
- `jobsKeywords`: optional native Jobs queries. Remove entries to omit that source.
- `protection`: bounded application policy; all sources share these rolling limits.

Choose Posts, freshness sorting and a time window in the ordinary interface when capturing search configuration. Do not include session or authentication values in the path. There is deliberately no baked-in private query ID advertised as stable.

## Response handling

Supported surfaces include normalized Voyager collections, HTML post cards and recognized streaming pagination responses. Reposts preserve available original text. Media images may be forwarded to OCR when a usable identity and URL are available. A partial text is marked and may be hydrated within budget.

Feed pagination and HTML search continuation replay only recognized server-issued instructions or same-host next links. A disabled Next control means the end of results; no recognized control means unknown coverage. Unsupported formats are reported rather than silently counted as a successful empty response.

Publication time comes from response data or a timestamp encoded in the post ID where applicable. Jobs dates can have day precision and are shown without invented hours.

## Diagnostics

```sh
npm run linkedin:check                 # Saved state only; no LinkedIn request
npm run linkedin:check -- --probe feed # One explicitly requested, protected check
```

The database connection is required so diagnostics cannot bypass the shared budget. See the protection guide for confirmed probes after an actual restriction. Parser changes should be tested with synthetic/sanitized fixtures first.
