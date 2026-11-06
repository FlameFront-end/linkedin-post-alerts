import { LinkedInSource } from '../services/collector/src/sources/linkedin.js';
import { loadSettings } from '../services/collector/src/linkedin/settings.js';
import { LinkedInError } from '../services/collector/src/linkedin/errors.js';
try {
  const source = new LinkedInSource(
    await loadSettings(
      process.env.LINKEDIN_CONFIG_FILE ?? '.local/linkedin.json',
    ),
  );
  source.onPage = (page) =>
    console.log(JSON.stringify({ event: 'page', ...page }));
  let count = 0;
  for await (const page of source.fetchBatches()) {
    count += page.length;
    for (const post of page.slice(0, 2))
      console.log(
        JSON.stringify({
          event: 'sample',
          textLength: post.text.length,
          authorPresent: post.author !== 'LinkedIn author',
          publishedAt: post.publishedAt,
        }),
      );
  }
  const failed = source.reports.filter(
    (r) => !['ok', 'partial', 'budget', 'skipped'].includes(r.status),
  );
  console.log(
    JSON.stringify({
      status: failed.length ? 'failed' : count ? 'ok' : 'empty',
      recentPosts: count,
      requests: source.requestsUsed,
      targets: source.reports,
    }),
  );
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      code: error instanceof LinkedInError ? error.code : 'internal',
      reason: error instanceof LinkedInError ? error.reason : undefined,
    }),
  );
  process.exitCode = 1;
}
